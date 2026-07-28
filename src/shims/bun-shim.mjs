// Preload: install Node-side polyfills for the Bun globals droid uses.
// Run via `node --import ./bun-shim.mjs`.

import { spawn as cpSpawn, spawnSync as cpSpawnSync } from 'node:child_process';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath as nodeFileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import bufferModule from 'node:buffer';
import { bunServe } from './bun-serve.mjs';

// Droid occasionally calls `.join()` on values typed as string|string[].
// Arrays keep their native join; strings ignore the separator and return themselves.
String.prototype.join = String.prototype.toString;

// ─── execPath / argv0 override ───
// droid's self-spawn (subagent fanout, restart-after-update) checks
// `basename(process.execPath).includes("droid")`; without this override
// it would see "node" and fall back to invoking the literal string "droid"
// from PATH, which probably points to the buggy standalone we're avoiding.
const wrapperPath = process.env.DROIDNODE_WRAPPER_PATH;
if (wrapperPath) {
  try { Object.defineProperty(process, 'execPath', { value: wrapperPath, configurable: true }); } catch { /* sealed */ }
  try { Object.defineProperty(process, 'argv0', { value: 'droid', configurable: true }); } catch { /* sealed */ }
  if (Array.isArray(process.argv) && process.argv.length > 0) process.argv[0] = wrapperPath;
}

// Polyfill `import.meta.require` (Bun-only) — patched into bundle below.
// Wrapped so we can intercept bare module specs that bundle expected from Bun's
// runtime (node-fetch, abort-controller) and route them to Node's built-ins.
// This lets us run with ZERO of those external packages installed.
const _nodeRequire = createRequire(import.meta.url);
const _builtinShims = {
  // Both Node 18+ and Bun expose fetch/Request/Response/Headers globally.
  // Gaxios does `WPL(uL("node-fetch"))` at module init then `window.fetch ?? RxB.default`.
  'node-fetch': (() => {
    const f = globalThis.fetch;
    const exp = Object.assign(function(...a) { return f(...a); }, {
      default: f,
      fetch: f,
      Request: globalThis.Request,
      Response: globalThis.Response,
      Headers: globalThis.Headers,
      FormData: globalThis.FormData,
      Blob: globalThis.Blob,
    });
    return exp;
  })(),
  // Node 15+ and Bun have these globals; no need for the legacy polyfill package.
  'abort-controller': {
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    default: globalThis.AbortController,
  },
};
globalThis.__bunRequire = function(spec) {
  if (spec in _builtinShims) return _builtinShims[spec];
  return _nodeRequire(spec);
};

// Node 22+ removed `Buffer.SlowBuffer`; bundle's bundled `buffer-equal-constant-time`
// does `require('buffer').SlowBuffer`. Aliasing keeps prototype.equal install path alive.
if (!bufferModule.SlowBuffer) bufferModule.SlowBuffer = bufferModule.Buffer;
if (!globalThis.SlowBuffer) globalThis.SlowBuffer = bufferModule.Buffer;

function adaptSpawnArgs(args) {
  // Bun.spawn signature: spawn(cmd[], opts)  OR  spawn({cmd, ...opts})
  let cmd, opts = {};
  if (Array.isArray(args[0])) {
    cmd = args[0]; opts = args[1] || {};
  } else {
    cmd = args[0].cmd; opts = args[0];
  }
  return [cmd, opts];
}

const stdioMap = (s) => {
  if (s === undefined || s === 'pipe') return 'pipe';
  if (s === 'ignore' || s === null) return 'ignore';
  if (s === 'inherit') return 'inherit';
  return s;
};

function bunSpawn(...args) {
  const [cmd, opts] = adaptSpawnArgs(args);
  const stdio = [stdioMap(opts.stdin), stdioMap(opts.stdout), stdioMap(opts.stderr)];
  const child = cpSpawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: opts.env, stdio });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout && (Readable.toWeb ? Readable.toWeb(child.stdout) : child.stdout),
    stderr: child.stderr && (Readable.toWeb ? Readable.toWeb(child.stderr) : child.stderr),
    exited: new Promise((res) => child.once('exit', (code) => res(code ?? 0))),
    kill: (sig) => child.kill(sig),
    get exitCode() { return child.exitCode; },
  };
}

function bunSpawnSync(...args) {
  const [cmd, opts] = adaptSpawnArgs(args);
  const stdio = [stdioMap(opts.stdin), stdioMap(opts.stdout), stdioMap(opts.stderr)];
  const r = cpSpawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd, env: opts.env, stdio,
    input: opts.stdin instanceof Buffer ? opts.stdin : undefined,
  });
  return {
    pid: r.pid, stdout: r.stdout, stderr: r.stderr,
    exitCode: r.status, signalCode: r.signal, success: r.status === 0,
  };
}

function bunFile(path) {
  return {
    text: () => Promise.resolve(readFileSync(path, 'utf8')),
    json: () => Promise.resolve(JSON.parse(readFileSync(path, 'utf8'))),
    arrayBuffer: () => Promise.resolve(readFileSync(path).buffer),
    bytes: () => Promise.resolve(new Uint8Array(readFileSync(path))),
    stream: () => createReadStream(path),
    get size() { try { return statSync(path).size; } catch { return 0; } },
    get exists() { try { statSync(path); return true; } catch { return false; } },
    name: path,
  };
}

function bunWhich(cmd) {
  const r = cpSpawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function bunGc() {
  if (typeof globalThis.gc === 'function') globalThis.gc();
}

function bunConnect(opts) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: opts.hostname, port: opts.port });
    sock.on('connect', () => { opts.socket?.open?.(sock); resolve(sock); });
    sock.on('data', (d) => opts.socket?.data?.(sock, d));
    sock.on('close', () => opts.socket?.close?.(sock));
    sock.on('error', (e) => { opts.socket?.error?.(sock, e); reject(e); });
  });
}

function bunServeStub() {
  throw new Error('[bun-shim] Bun.serve unsupported under Node. `droid daemon` needs Bun.');
}

globalThis.Bun = globalThis.Bun ?? {
  spawn: bunSpawn,
  spawnSync: bunSpawnSync,
  file: bunFile,
  which: bunWhich,
  gc: bunGc,
  connect: bunConnect,
  serve: bunServe,
  fileURLToPath: nodeFileURLToPath,
  version: '1.3.13-shim',
  revision: 'droidnode',
  env: process.env,
  argv: process.argv,
  main: process.argv[1],
};
