// Guards the .bun-section reader and the launcher's behaviour when it can't
// read a bundle. Skipped when no droid binary is installed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDroidBinary } from '../lib/locate.js';
import { extract } from '../lib/extract.js';

const droid = findDroidBinary();
const skip = droid.path ? false : 'no droid binary installed';

test('extracts the JS bundle and embedded assets from the droid binary', { skip }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'droidnode-extract-test-'));
  try {
    const dir = extract(droid.path, join(temp, 'cache'), { quiet: true });

    const bundle = readFileSync(join(dir, 'droid.node.mjs'), 'utf8');
    // A real droid bundle is tens of MB; a mis-parsed table yields a stub.
    assert.ok(bundle.length > 1_000_000, `bundle too small: ${bundle.length} bytes`);
    assert.match(bundle.slice(0, 64), /^\/\/ @bun/);

    // Every Node-incompatible construct must be patched out.
    assert.ok(!bundle.includes('import.meta.require'), 'import.meta.require left in bundle');
    assert.ok(!bundle.includes('"bun:ffi"'), 'bun:ffi import left in bundle');
    assert.ok(!bundle.includes('"bun:jsc"'), 'bun:jsc import left in bundle');
    assert.ok(!bundle.includes('this.server=Bun.serve('), 'Bun.serve left un-awaited');

    // Embedded assets (ripgrep, the PTY library, builtin skills) must land on
    // disk — the TUI reports "Skills (…)" forever when they don't.
    const embedded = join(dir, 'embedded');
    assert.ok(statSync(embedded).isDirectory());
    const rg = readFileSync(join(embedded, findEntry(embedded, /^rg-/)));
    assert.ok(rg.length > 1_000_000, 'ripgrep asset looks truncated');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function findEntry(dir, pattern) {
  const match = readdirSync(dir).find((name) => pattern.test(name));
  assert.ok(match, `no embedded entry matching ${pattern}`);
  return match;
}

// A binary whose trailer we've corrupted stands in for "some future Bun writes
// a layout we don't parse". Extraction must name itself rather than throwing
// something opaque from deep in the offset arithmetic.
function withCorruptedBinary(fn) {
  const temp = mkdtempSync(join(tmpdir(), 'droidnode-corrupt-'));
  try {
    const copy = join(temp, 'droid');
    const buf = readFileSync(droid.path);
    const at = buf.lastIndexOf(Buffer.from('\n---- Bun! ----\n'));
    assert.ok(at > 0, 'test fixture needs a locatable trailer');
    buf.write('\n---- Nope! ---\n', at, 'latin1');
    writeFileSync(copy, buf, { mode: 0o755 });
    return fn(copy);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('an unreadable bundle fails with a diagnosable error', { skip }, () => {
  withCorruptedBinary((copy) => {
    const temp = mkdtempSync(join(tmpdir(), 'droidnode-corrupt-out-'));
    try {
      assert.throws(
        () => extract(copy, join(temp, 'cache'), { quiet: true }),
        /could not read the embedded bundle.*droid --version/s,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

test('the launcher falls back to the stock binary, and honours the opt-out', { skip }, () => {
  withCorruptedBinary((copy) => {
    const cache = mkdtempSync(join(tmpdir(), 'droidnode-fallback-'));
    const wrapper = join(import.meta.dirname, '..', 'bin', 'droidnode.js');
    const run = (extraEnv) => spawnSync(process.execPath, [wrapper, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, DROID_BIN: copy, XDG_CACHE_HOME: cache, ...extraEnv },
    });
    try {
      const fell = run({});
      assert.match(fell.stderr, /falling back to the stock droid binary/);
      assert.match(fell.stderr, /are NOT active/);

      const refused = run({ DROIDNODE_NO_FALLBACK: '1' });
      assert.equal(refused.status, 1, 'DROIDNODE_NO_FALLBACK must fail hard');
      assert.doesNotMatch(refused.stderr, /falling back to the stock droid binary/);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
