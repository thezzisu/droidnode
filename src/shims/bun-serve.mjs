// Bun.serve polyfill for Node.js.
// Implements the subset droid's DaemonServer uses:
//   Bun.serve({ unix, fetch, websocket })             // Unix socket
//   Bun.serve({ hostname, port, fetch, websocket })   // TCP
//   fetch(req, server) -> Response | undefined        // undefined when upgraded
//   server.upgrade(req, { data }) -> boolean
//   websocket handlers: { open(ws), message(ws,data), close(ws,code,reason), pong(ws), ping(ws), drain(ws) }
//   ws.data            // custom data set at upgrade time
//   ws.send(data)
//   ws.close(code?, reason?)
//
// Backed by node:http + ws package.

import http from 'node:http';
import { unlinkSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
// `ws` is loaded lazily inside bunServe() so droid commands that never call
// Bun.serve (--version, --help, --resume without daemon) don't require it.

// Per-request upgrade context: maps an upgrade-eligible Request → { data, accepted }.
// Inside the fetch handler we set `accepted = true`; after fetch returns we look up
// this entry on the raw upgrade event and complete the handshake via ws.handleUpgrade().
const upgradeRegistry = new WeakMap();

function nodeReqToWebRequest(nodeReq, isUpgrade = false) {
  const host = nodeReq.headers.host ?? 'localhost';
  const proto = nodeReq.headers['x-forwarded-proto'] ?? (nodeReq.socket.encrypted ? 'https' : 'http');
  const url = new URL(nodeReq.url, `${proto}://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
    else if (v !== undefined) headers.set(k, String(v));
  }
  // Methods other than GET/HEAD may have a body — wrap node stream as web ReadableStream
  let body = null;
  if (!isUpgrade && nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    body = Readable.toWeb ? Readable.toWeb(nodeReq) : nodeReq;
  }
  const req = new Request(url, {
    method: nodeReq.method,
    headers,
    body,
    duplex: body ? 'half' : undefined,
  });
  return req;
}

async function sendWebResponseToNode(webResp, nodeRes) {
  if (!webResp) {
    nodeRes.writeHead(204);
    nodeRes.end();
    return;
  }
  const headers = {};
  webResp.headers.forEach((v, k) => {
    if (headers[k]) headers[k] = `${headers[k]}, ${v}`;
    else headers[k] = v;
  });
  nodeRes.writeHead(webResp.status, headers);
  if (!webResp.body) { nodeRes.end(); return; }
  // Stream body
  const reader = webResp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) nodeRes.write(value);
  }
  nodeRes.end();
}

function wrapWs(wsConn, data, handlers) {
  // Bun-style ws wrapper around a `ws` package WebSocket. Exposed to handlers.
  const wrapper = {
    data,
    get readyState() { return wsConn.readyState; },
    get remoteAddress() { return wsConn._socket?.remoteAddress; },
    send(message, compress) {
      if (typeof message === 'string') wsConn.send(message);
      else if (message instanceof ArrayBuffer) wsConn.send(Buffer.from(message));
      else wsConn.send(message);
      return message?.length ?? 0;
    },
    close(code, reason) { wsConn.close(code, reason); },
    terminate() { wsConn.terminate(); },
    ping(data) { try { wsConn.ping(data); } catch {} },
    pong(data) { try { wsConn.pong(data); } catch {} },
    subscribe() {}, unsubscribe() {}, publish() {}, // pubsub stub (not used by droid)
    isSubscribed() { return false; },
  };
  wsConn.on('message', (raw, isBinary) => {
    const payload = isBinary ? raw : raw.toString('utf8');
    try { handlers.message?.(wrapper, payload); } catch (e) { console.error('[bun-serve] message handler threw:', e); }
  });
  wsConn.on('close', (code, reason) => {
    try { handlers.close?.(wrapper, code, reason?.toString('utf8') ?? ''); } catch (e) { console.error('[bun-serve] close handler threw:', e); }
  });
  wsConn.on('pong', () => { try { handlers.pong?.(wrapper); } catch (e) { console.error('[bun-serve] pong handler threw:', e); } });
  wsConn.on('ping', () => { try { handlers.ping?.(wrapper); } catch (e) { console.error('[bun-serve] ping handler threw:', e); } });
  wsConn.on('error', (e) => { try { handlers.error?.(wrapper, e); } catch {} });
  // Idle timeout (Bun default 120s, droid passes idleTimeout via spread)
  if (handlers.idleTimeout && handlers.idleTimeout > 0) {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => wsConn.terminate(), handlers.idleTimeout * 1000);
      timer.unref?.();
    };
    wsConn.on('message', reset);
    wsConn.on('pong', reset);
    reset();
    wsConn.on('close', () => clearTimeout(timer));
  }
  return wrapper;
}

export function bunServe(opts) {
  const wsHandlers = opts.websocket || {};
  const fetchHandler = opts.fetch;
  if (typeof fetchHandler !== 'function') {
    throw new Error('[bun-serve] fetch handler is required');
  }

  const httpServer = http.createServer();
  // Lazy: only needed when an actual upgrade request arrives, so daemon-less commands skip ws.
  let wsServer = null;
  const getWsServer = async () => {
    if (!wsServer) {
      const { WebSocketServer } = await import('ws');
      wsServer = new WebSocketServer({ noServer: true });
    }
    return wsServer;
  };

  const server = {
    hostname: opts.hostname,
    port: opts.port,
    development: false,
    stop(closeActiveConnections) {
      return new Promise((resolve) => {
        if (closeActiveConnections) {
          wsServer?.clients?.forEach(c => c.terminate());
        }
        httpServer.close(() => resolve());
      });
    },
    /**
     * Bun's server.upgrade(req, {data}) — marks the request for WS upgrade.
     * Returns true on success. Actual handshake happens after fetch handler returns.
     */
    upgrade(req, info) {
      const entry = upgradeRegistry.get(req);
      if (!entry) return false; // not an upgrade-eligible request
      entry.data = info?.data;
      entry.accepted = true;
      return true;
    },
    publish() { /* pubsub stub */ },
    requestIP(req) {
      const sock = upgradeRegistry.get(req)?.socket ?? req.__nodeSocket;
      return sock ? { address: sock.remoteAddress, family: sock.remoteFamily, port: sock.remotePort } : null;
    },
  };

  // Regular HTTP requests
  httpServer.on('request', async (nodeReq, nodeRes) => {
    try {
      const webReq = nodeReqToWebRequest(nodeReq);
      webReq.__nodeSocket = nodeReq.socket;
      const result = await fetchHandler(webReq, server);
      await sendWebResponseToNode(result, nodeRes);
    } catch (e) {
      console.error('[bun-serve] fetch handler error:', e);
      if (!nodeRes.headersSent) nodeRes.writeHead(500);
      nodeRes.end();
    }
  });

  // WebSocket upgrade requests
  httpServer.on('upgrade', async (nodeReq, socket, head) => {
    const webReq = nodeReqToWebRequest(nodeReq, true);
    const entry = { data: undefined, accepted: false, socket };
    upgradeRegistry.set(webReq, entry);
    try {
      const result = await fetchHandler(webReq, server);
      if (!entry.accepted) {
        // fetch returned a Response or rejected upgrade — write it to the raw socket as HTTP
        const status = result?.status ?? 400;
        socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Bad Request'}\r\n\r\n`);
        socket.destroy();
        return;
      }
      // Complete handshake; ws package handles it
      (await getWsServer()).handleUpgrade(nodeReq, socket, head, (wsConn) => {
        const wrapper = wrapWs(wsConn, entry.data, wsHandlers);
        try { wsHandlers.open?.(wrapper); } catch (e) { console.error('[bun-serve] open handler threw:', e); }
      });
    } catch (e) {
      console.error('[bun-serve] upgrade fetch error:', e);
      try { socket.destroy(); } catch {}
    }
  });

  // Listen — async to surface EADDRINUSE the same way as Bun.serve (synchronous-looking throw)
  // Bun.serve throws synchronously; we have to fake that with a sync listen + Promise-trapped error.
  return new Promise((resolve, reject) => {
    const onErr = (err) => { reject(err); };
    httpServer.once('error', onErr);
    const onListen = () => {
      httpServer.off('error', onErr);
      httpServer.on('error', (e) => console.error('[bun-serve] post-listen error:', e));
      // Update server.port to actual bound port (Bun does this for port:0)
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') server.port = addr.port;
      resolve(server);
    };
    if (opts.unix) {
      // Bun supports auto-overwriting stale unix sockets; mirror behavior
      try { if (existsSync(opts.unix)) unlinkSync(opts.unix); } catch {}
      httpServer.listen(opts.unix, onListen);
    } else {
      httpServer.listen(opts.port ?? 0, opts.hostname ?? '0.0.0.0', onListen);
    }
  });
}
