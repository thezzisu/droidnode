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
} finally {
  rmSync(cacheBase, { recursive: true, force: true });
}
