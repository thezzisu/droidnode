import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAnonymousPackage } from '../scripts/build-anonymous-package.js';

const ROOT = join(import.meta.dirname, '..');
const RUNTIME_ENTRIES = ['bin', 'lib', 'src'];

function fileHashes(root, entries) {
  const hashes = {};
  const visit = (relative) => {
    const path = join(root, relative);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(relative, entry));
      return;
    }
    hashes[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  for (const entry of entries) visit(entry);
  return hashes;
}

test('anonymous package preserves runtime bytes and removes identity metadata', () => {
  const temp = mkdtempSync(join(tmpdir(), 'droidnode-package-test-'));
  try {
    const output = buildAnonymousPackage(join(temp, 'package'));
    const scoped = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const anonymous = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));

    const expectedManifest = { ...scoped, name: 'droidnode' };
    for (const field of ['author', 'repository', 'bugs', 'homepage']) {
      delete expectedManifest[field];
    }
    assert.deepEqual(anonymous, expectedManifest);

    assert.deepEqual(
      fileHashes(output, RUNTIME_ENTRIES),
      fileHashes(ROOT, RUNTIME_ENTRIES),
    );
    assert.match(readFileSync(join(output, 'README.md'), 'utf8'), /npm install -g droidnode/);
    assert.match(readFileSync(join(output, 'LICENSE'), 'utf8'), /droidnode contributors/);

    // droid >= 0.213 spawns process.execPath (our wrapper) directly to start a
    // session backend, so the launcher has to stay executable through the copy.
    assert.ok(
      statSync(join(output, 'bin', 'droidnode.js')).mode & 0o111,
      'bin/droidnode.js must keep its executable bit in the anonymous package',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
