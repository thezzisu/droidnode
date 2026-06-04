#!/usr/bin/env node
// Update package.json so the @thezzisu/droidnode version mirrors the
// requested droid version, and bump the `droid` dependency range to
// `^<droid-version>` so npm resolves to that release on install.
//
// Usage: node scripts/sync-version.js <droid-version>
// Prints "changed" or "unchanged" so the workflow can decide whether
// to open a PR.

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

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const oldOwn = pkg.version;
const oldDep = pkg.dependencies?.droid;
pkg.version = target;
pkg.dependencies ??= {};
pkg.dependencies.droid = `^${target}`;

if (oldOwn === pkg.version && oldDep === pkg.dependencies.droid) {
  console.log('unchanged');
  process.exit(0);
}

writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
console.log(`changed ${oldOwn} -> ${pkg.version} (droid ${oldDep} -> ${pkg.dependencies.droid})`);
