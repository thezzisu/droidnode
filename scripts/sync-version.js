#!/usr/bin/env node
// Update package.json so the wrapper version matches the latest droid
// release, and the `droid` dep range follows it. Refuses to downgrade so
// a wrapper-only patch (e.g. 0.140.1 against droid 0.140.0) is preserved
// until droid itself moves past it.
//
// Usage: node scripts/sync-version.js <droid-version>
//   Prints "changed <old> -> <new>" or "unchanged" so the auto-track
//   workflow can decide whether to commit + tag.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(resolve(__dirname, '..'), 'package.json');

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+/.test(target)) {
  console.error('usage: sync-version.js <semver>');
  process.exit(2);
}

// Parse strictly numeric major.minor.patch (ignore any -shim.N suffix on ours).
function parts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`bad semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmp(a, b) {
  const A = parts(a), B = parts(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const oldOwn = pkg.version;
const oldDep = pkg.dependencies?.droid;

// Never downgrade. Wrapper-only patches like 0.140.0 -> 0.140.1 are
// preserved until droid itself ships >= 0.140.1.
if (cmp(oldOwn, target) >= 0) {
  console.log('unchanged (current already >= target)');
  process.exit(0);
}

pkg.version = target;
pkg.dependencies ??= {};
pkg.dependencies.droid = `^${target}`;

if (oldOwn === pkg.version && oldDep === pkg.dependencies.droid) {
  console.log('unchanged');
  process.exit(0);
}

writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
console.log(`changed ${oldOwn} -> ${pkg.version} (droid ${oldDep} -> ${pkg.dependencies.droid})`);
