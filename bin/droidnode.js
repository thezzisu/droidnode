#!/usr/bin/env node
// droidnode — Node-side launcher that runs Factory's droid CLI under a
// separately-installed Bun, sidestepping the Bun 1.3.x standalone-init
// NULL-allocator race responsible for `Segmentation fault at address 0x0`
// during `droid --resume` of large sessions.
//
// See README.md for the full root-cause analysis. droid itself, the JS
// bundle this launcher extracts, and the @factory/cli-* binaries are
// © Factory AI — see their terms. This launcher is MIT.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { findDroidBinary, findBunBinary } from '../lib/locate.js';
import { ensureExtracted } from '../lib/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const PRELOAD = join(PKG_ROOT, 'src', 'preload.js');

function die(msg, code = 1) {
  process.stderr.write(`droidnode: ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);

// Internal escape hatches
if (args[0] === '--print-paths') {
  const droid = findDroidBinary();
  const bun = findBunBinary();
  const dir = droid.path ? (await import('../lib/extract.js')).cacheDirFor(droid.path) : null;
  console.log(JSON.stringify({ droid, bun, cacheDir: dir }, null, 2));
  process.exit(0);
}
if (args[0] === '--reextract') {
  const droid = findDroidBinary();
  if (!droid.path) die('droid binary not found; cannot re-extract');
  const { extract, cacheDirFor } = await import('../lib/extract.js');
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

const bun = findBunBinary();
if (!bun.path) {
  die(
    `cannot locate a working \`bun\` runtime.\n` +
    `  - Set $BUN_BIN to an explicit path, OR\n` +
    `  - Install bun: https://bun.sh/docs/installation`,
  );
}

const cacheDir = ensureExtracted(droid.path, { quiet: !process.env.DROIDNODE_VERBOSE });
const droidJs = join(cacheDir, 'droid.js');

// Make the spawned bun think it was invoked through *our* CLI so any
// self-spawn (subagents, restart-after-update) re-enters the same wrapper.
const wrapperPath = process.env.DROIDNODE_WRAPPER_PATH
  ?? process.argv[1]
  ?? join(PKG_ROOT, 'bin', 'droidnode.js');

const env = {
  ...process.env,
  DROIDNODE_WRAPPER_PATH: wrapperPath,
  DROIDNODE_DROID_BIN: droid.path,
  DROIDNODE_BUN_BIN: bun.path,
};

const result = spawnSync(
  bun.path,
  ['--preload', PRELOAD, droidJs, ...args],
  { stdio: 'inherit', env },
);

if (result.error) die(`failed to spawn bun: ${result.error.message}`);
if (result.signal) {
  // Re-raise signal so callers see the right exit code
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 0);
}
