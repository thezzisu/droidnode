// Find the real droid binary on this system.
//
// Resolution order:
//   1. $DROID_BIN explicit override
//   2. droid npm package's platform.js → @factory/cli-<platform>/bin/droid
//   3. `droid` in PATH — skipped if it's our own wrapper (size/ELF heuristic)
//   4. Common manual-install locations (~/.local/bin/droid{,.bun-orig})

import { createRequire } from 'node:module';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const require = createRequire(import.meta.url);

const MIN_REAL_DROID_SIZE = 50 * 1024 * 1024; // real binary ≈150 MB; wrappers are tiny

function magicMatches(p) {
  try {
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    // ELF (Linux), Mach-O thin / fat (macOS), PE / MZ (Windows)
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    const m = buf.readUInt32BE(0);
    if (m === 0xcafebabe || m === 0xcffaedfe || m === 0xfeedfacf) return true;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
    return false;
  } catch {
    return false;
  }
}

function isLikelyRealDroidBinary(p) {
  try {
    const s = statSync(p);
    if (!s.isFile()) return false;
    if (s.size < MIN_REAL_DROID_SIZE) return false;
    return magicMatches(p);
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

  if (process.env.DROID_BIN) push('$DROID_BIN', process.env.DROID_BIN);

  try {
    const platform = require('droid/platform.js');
    const info = platform.getBinaryPathWithInfo?.() ?? null;
    if (info?.path) push('droid npm package', info.path);
  } catch { /* ignore */ }

  for (const p of searchPath('droid')) push('PATH', p);

  push('~/.local/bin/droid.bun-orig', join(homedir(), '.local/bin/droid.bun-orig'));
  push('~/.local/bin/droid', join(homedir(), '.local/bin/droid'));

  for (const c of tried) {
    if (isLikelyRealDroidBinary(c.path)) {
      return { path: c.path, source: c.label };
    }
  }
  return { path: null, source: null, tried };
}
