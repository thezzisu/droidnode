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

import { spawnSync } from 'node:child_process';
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
