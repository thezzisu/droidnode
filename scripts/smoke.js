#!/usr/bin/env node
// Verify the launcher extracts and runs `--version` against a droid binary
// resolved via the normal npm-install path. Exit non-zero on any mismatch.
//
// Usage: node scripts/smoke.js [expected-droid-version]
//   - If a version is provided, asserts the launcher reports it back.
//   - Otherwise just asserts a non-empty semver-shaped string.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const expected = process.argv[2];
const cacheBase = mkdtempSync(join(tmpdir(), 'droidnode-smoke-'));

try {
  const result = spawnSync(
    process.execPath,
    [join(PKG_ROOT, 'bin', 'droidnode.js'), '--version'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      env: { ...process.env, XDG_CACHE_HOME: cacheBase },
    },
  );
  if (result.error) {
    console.error(`smoke: failed to launch wrapper: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`smoke: launcher exited with ${result.status}`);
    process.exit(1);
  }
  const out = (result.stdout || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(out)) {
    console.error(`smoke: expected semver, got: ${JSON.stringify(out)}`);
    process.exit(1);
  }
  if (expected && !out.startsWith(expected)) {
    console.error(`smoke: expected ${expected}, got ${out}`);
    process.exit(1);
  }
  console.log(`smoke OK: droid ${out}`);

  // `--version` exits before the daemon starts, so it passes even when the
  // launcher can't be re-spawned. droid executes process.execPath to start each
  // session backend, so assert the wrapper is actually spawnable — otherwise
  // every interactive session fails with "permission denied" while this smoke
  // test stays green (which is exactly how that shipped unnoticed).
  const wrapper = join(PKG_ROOT, 'bin', 'droidnode.js');
  const probe = spawnSync(wrapper, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, XDG_CACHE_HOME: cacheBase },
  });
  if (probe.error) {
    console.error(`smoke: wrapper is not directly executable: ${probe.error.message}`);
    console.error('       droid spawns process.execPath to start sessions; run `chmod +x bin/droidnode.js`.');
    process.exit(1);
  }
  if (probe.status !== 0) {
    console.error(`smoke: direct wrapper exec exited with ${probe.status}: ${probe.stderr?.trim()}`);
    process.exit(1);
  }
  console.log('smoke OK: wrapper is directly executable');
} finally {
  rmSync(cacheBase, { recursive: true, force: true });
}
