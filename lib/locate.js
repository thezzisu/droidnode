// Find the real droid binary and a working `bun` runtime.
//
// - Droid: prefer the `droid` npm package (which transitively installs
//   `@factory/cli-<platform>` and exposes `platform.js`). Fall back to
//   $DROID_BIN, then to a sibling `droid` in PATH if it's the real 100MB+
//   binary (not our launcher).
// - Bun: prefer $BUN_BIN, then ~/.bun/bin/bun, then the `bun` npm package
//   bundled binary, then PATH. Any version known to NOT use the standalone
//   init path will do — we never compile-link Bun, we just invoke it as
//   a normal CLI on the extracted JS.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const MIN_REAL_DROID_SIZE = 50 * 1024 * 1024; // wrappers/shims are tiny; real binary is ~150 MB

function isElf(p) {
  try {
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch {
    return false;
  }
}

function isMachOOrPE(p) {
  try {
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    const m = buf.readUInt32BE(0);
    // Mach-O fat / 64-bit + PE/MZ
    return m === 0xcafebabe || m === 0xcffaedfe || m === 0xfeedfacf || (buf[0] === 0x4d && buf[1] === 0x5a);
  } catch {
    return false;
  }
}

function isLikelyRealDroidBinary(p) {
  try {
    const s = statSync(p);
    if (!s.isFile()) return false;
    if (s.size < MIN_REAL_DROID_SIZE) return false;
    return isElf(p) || isMachOOrPE(p);
  } catch {
    return false;
  }
}

function searchPath(name) {
  const PATH = process.env.PATH || '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const found = [];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) found.push(p);
    }
  }
  return found;
}

export function findDroidBinary() {
  const tried = [];
  const push = (label, p) => { if (p) tried.push({ label, path: p }); };

  // 1. $DROID_BIN explicit override
  if (process.env.DROID_BIN) push('$DROID_BIN', process.env.DROID_BIN);

  // 2. droid npm package's platform.js, which resolves to @factory/cli-<plat>
  try {
    const platformJs = require.resolve('droid/platform.js');
    const platform = require(platformJs);
    const info = platform.getBinaryPathWithInfo?.() ?? null;
    if (info?.path) push('droid npm package', info.path);
  } catch { /* ignore */ }

  // 3. `droid` in PATH — but skip our own wrapper (it's a small shell script)
  for (const p of searchPath('droid')) push('PATH', p);

  // 4. Common locations a user might leave the original binary at
  push('~/.local/bin/droid.bun-orig', join(homedir(), '.local/bin/droid.bun-orig'));
  push('~/.local/bin/droid', join(homedir(), '.local/bin/droid'));

  for (const c of tried) {
    if (isLikelyRealDroidBinary(c.path)) {
      return { path: c.path, source: c.label };
    }
  }
  return { path: null, source: null, tried };
}

export function findBunBinary() {
  const candidates = [];
  if (process.env.BUN_BIN) candidates.push({ label: '$BUN_BIN', path: process.env.BUN_BIN });
  candidates.push({ label: '~/.bun/bin/bun', path: join(homedir(), '.bun/bin/bun') });
  try {
    // `bun` npm package vendors a binary at bin/bun
    const bunPkg = require.resolve('bun/package.json');
    const dir = bunPkg.replace(/package\.json$/, '');
    const candidate = join(dir, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    candidates.push({ label: 'bun npm package', path: candidate });
  } catch { /* ignore */ }
  for (const p of searchPath(process.platform === 'win32' ? 'bun.exe' : 'bun')) {
    candidates.push({ label: 'PATH', path: p });
  }
  for (const c of candidates) {
    try {
      if (existsSync(c.path) && statSync(c.path).isFile()) {
        execFileSync(c.path, ['--version'], { stdio: 'ignore' });
        return { path: c.path, source: c.label };
      }
    } catch { /* not executable, keep trying */ }
  }
  return { path: null, source: null, tried: candidates };
}
