#!/usr/bin/env node
// droidnode — run Factory's droid CLI on plain Node.js (no Bun runtime).
//
// Why Node and not Bun: Bun 1.3.x has both the standalone-init NULL-allocator
// race that crashes `droid --resume`, and broader memory-leak issues during
// long sessions. We extract the JS bundle Factory ships, apply a small set of
// Node-compatible patches (Bun.* globals shimmed, import.meta.require routed
// through createRequire, Bun.serve polyfilled via node:http + ws, Bun.FFI
// dlopen routed through koffi), and run it under whatever `node` invoked us.
//
// © Factory AI for droid itself, its JS bundle, and `@factory/cli-*` binaries
// — see README.md. This launcher is MIT.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { findDroidBinary } from '../lib/locate.js';
import { ensureExtracted, cacheDirFor, SHIM_DIR } from '../lib/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const PRELOAD_URL = `file://${join(SHIM_DIR, 'bun-shim.mjs')}`;

function die(msg, code = 1) {
  process.stderr.write(`droidnode: ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);

if (args[0] === '--print-paths') {
  const droid = findDroidBinary();
  const dir = droid.path ? cacheDirFor(droid.path) : null;
  console.log(JSON.stringify({
    droid,
    node: process.execPath,
    shimDir: SHIM_DIR,
    cacheDir: dir,
  }, null, 2));
  process.exit(0);
}
if (args[0] === '--reextract') {
  const droid = findDroidBinary();
  if (!droid.path) die('droid binary not found; cannot re-extract');
  const { extract } = await import('../lib/extract.js');
  extract(droid.path, cacheDirFor(droid.path));
  process.exit(0);
}

const droid = findDroidBinary();
if (!droid.path) {
  die(
    `cannot locate the real droid binary.\n` +
    `  - Set $DROID_BIN to an explicit path, OR\n` +
    `  - Install droid: \`npm install -g droid\` (recommended), OR\n` +
    `  - Place the original binary at ~/.local/bin/droid.bun-orig`,
  );
}

const cacheDir = ensureExtracted(droid.path, { quiet: !process.env.DROIDNODE_VERBOSE });
const droidMjs = join(cacheDir, 'droid.node.mjs');

const wrapperPath = process.env.DROIDNODE_WRAPPER_PATH
  ?? process.argv[1]
  ?? join(PKG_ROOT, 'bin', 'droidnode.js');

const env = {
  ...process.env,
  DROIDNODE_WRAPPER_PATH: wrapperPath,
  DROIDNODE_DROID_BIN: droid.path,
};

// ─── IPC channel pass-through ───
// droid's in-process daemon runtime spawns one `droid exec --input-format
// stream-jsonrpc` backend per session (including every mission worker) with a
// 4th `ipc` stdio fd and `serialization:"json"`. The backend detects that
// channel via `typeof process.send === "function"` and, when present, streams
// its live activity notifications (create_message / tool_call /
// tool_progress_update / droid_working_state_changed …) back to the organizer's
// session store over IPC — that store is exactly what MissionControl renders.
//
// Because our shim rewrites process.execPath to this wrapper, droid re-spawns
// `node droidnode exec …` instead of the bundle directly, inserting this
// process between the runtime and the real bundle. A plain spawnSync with
// stdio:'inherit' forwards only fd 0/1/2, so Node strips NODE_CHANNEL_FD from
// the bundle child: the backend falls back to an isolated "parent" runtime,
// the RPC/stdout path still works (mission completes, next worker spawns), but
// worker activity never reaches the organizer → missionControl.noWorkerActivity.
//
// Fix: when WE were spawned with an inherited IPC channel, give the bundle child
// its own `ipc` fd and transparently relay JSON messages both ways. Outside that
// path (user runs `droidnode` in a terminal) there's no parent channel and we
// keep the original stdio:'inherit' behavior unchanged.
const parentHasIpc = typeof process.send === 'function' && process.channel != null;

if (parentHasIpc) {
  // Let Node mint a fresh IPC channel for the child; drop the inherited
  // descriptor so the child doesn't try to reuse our parent's fd.
  const childEnv = { ...env };
  delete childEnv.NODE_CHANNEL_FD;
  delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;

  const child = spawn(
    process.execPath,
    ['--import', PRELOAD_URL, '--enable-source-maps', droidMjs, ...args],
    { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], serialization: 'json', env: childEnv },
  );

  // Transparent relay: runtime (our parent) ⇄ this wrapper ⇄ bundle (child).
  process.on('message', (m) => { try { child.send(m); } catch { /* child gone */ } });
  child.on('message', (m) => { try { process.send(m); } catch { /* parent gone */ } });
  process.on('disconnect', () => { try { child.disconnect(); } catch { /* already closed */ } });
  child.on('disconnect', () => { try { process.disconnect(); } catch { /* already closed */ } });

  // Forward terminating signals so Ctrl-C / daemon shutdown reaches the bundle.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already exited */ } });
  }

  let spawned = false;
  let exited = false;
  const finish = (code, signal) => {
    if (exited) return;
    exited = true;
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  };
  child.once('spawn', () => { spawned = true; });
  child.on('error', (e) => {
    // Before spawn: a real launch failure (ENOENT, EACCES…) → fatal.
    // After spawn: IPC-channel teardown races when the child exits without
    // using the channel (e.g. `--version`) surface here as benign errors;
    // ignore them and let the `exit` event carry the real status.
    if (!spawned) die(`failed to spawn node: ${e.message}`);
  });
  child.on('exit', (code, signal) => finish(code, signal));
} else {
  // `--import` (Node 19+, stable 20.6+) loads bun-shim.mjs before bundle.
  // `--enable-source-maps` keeps stack traces readable across our patches.
  const result = spawnSync(
    process.execPath,
    ['--import', PRELOAD_URL, '--enable-source-maps', droidMjs, ...args],
    { stdio: 'inherit', env },
  );

  if (result.error) die(`failed to spawn node: ${result.error.message}`);
  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.status ?? 0);
  }
}
