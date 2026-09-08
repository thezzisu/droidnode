// Guards the .bun-section reader against the two standalone layouts droid has
// shipped. Skipped when no droid binary is installed (e.g. a docs-only CI job).

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
