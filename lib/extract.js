// Extract the JS bundle and embedded resources from a droid Bun-standalone
// binary, then transform the bundle so it runs on plain Node.js (no Bun).
//
// Bun's `bun build --compile` lays the bundle into a dedicated `.bun` ELF
// section. Inside that section files are packed sequentially as
// `<path>\0<content><next-path>\0<content>...`. We walk the packed list by
// scanning for the `/$bunfs/root/` path prefix; ELF parsing isn't required.
//
// Transformations applied to the JS bundle, in order:
//   1. Truncate at `//# debugId=<hex>\n` — Bun appends raw Zstd-compressed
//      sourcemap blobs past that line, which break Node's JS parser.
//   2. `/$bunfs/root/` -> absolute path of the embedded dir, so runtime
//      filesystem lookups resolve.
//   3. `import.meta.require` -> `globalThis.__bunRequire` (installed by
//      bun-shim.mjs preload). Node has no `import.meta.require`.
//   4. `"bun:ffi"` -> absolute path to our koffi-backed shim.
//   5. `"bun:jsc"` -> absolute path to our heapStats() stub.
//   6. `this.server=Bun.serve(` -> `this.server=await Bun.serve(` ×2.
//      Our Bun.serve polyfill is async; Bun's original is sync.

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SHIM_DIR = join(PKG_ROOT, 'src', 'shims');

const BUNFS_PREFIX = '/$bunfs/root/';
const PATH_PREFIX_BYTES = Buffer.from(BUNFS_PREFIX, 'utf8');

function cacheKeyFor(binaryPath) {
  const st = statSync(binaryPath);
  // Sample head + tail + size of binary; XOR-style includes shim path so
  // that moving / reinstalling the npm package invalidates stale caches.
  const fd = openSync(binaryPath, 'r');
  const head = Buffer.alloc(64 * 1024);
  const tail = Buffer.alloc(64 * 1024);
  readSync(fd, head, 0, head.length, 0);
  readSync(fd, tail, 0, tail.length, Math.max(0, st.size - tail.length));
  closeSync(fd);
  const h = createHash('sha256');
  h.update(`${st.size}\0`);
  h.update(head);
  h.update(tail);
  h.update(`\0${SHIM_DIR}`);
  return h.digest('hex').slice(0, 16);
}

export function cacheRootDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : join(homedir(), '.cache');
  return join(base, 'droidnode');
}

export function cacheDirFor(binaryPath) {
  return join(cacheRootDir(), cacheKeyFor(binaryPath));
}

function findBunSection(buf) {
  // The `.bun` ELF section opens with `/$bunfs/root/droid\0// @bun\n`.
  // Locating it by needle works across droid versions without ELF parsing.
  const needle = Buffer.from(BUNFS_PREFIX + 'droid\0// @bun\n', 'utf8');
  const idx = buf.indexOf(needle);
  if (idx < 0) throw new Error('embedded bundle not found — is this really a droid Bun standalone?');
  return idx;
}

function findFileEntries(buf, startOffset) {
  const entries = [{ pathStart: startOffset }];
  let from = startOffset + 1;
  while (true) {
    const next = buf.indexOf(PATH_PREFIX_BYTES, from);
    if (next < 0) break;
    if (next === 0 || buf[next - 1] !== 0) {
      from = next + 1;
      continue;
    }
    entries.push({ pathStart: next });
    from = next + 1;
  }
  const resolved = [];
  for (let i = 0; i < entries.length; i++) {
    const pStart = entries[i].pathStart;
    const pEnd = buf.indexOf(0, pStart);
    if (pEnd < 0) break;
    const path = buf.slice(pStart, pEnd).toString('utf8');
    const contentStart = pEnd + 1;
    const contentEnd = (i + 1 < entries.length) ? entries[i + 1].pathStart : buf.length;
    resolved.push({ path, contentStart, contentEnd });
  }
  return resolved;
}

function trimBundleAtDebugId(jsBundle) {
  const m = jsBundle.toString('binary').match(/\/\/# debugId=[0-9A-Fa-f]+\n/);
  if (!m) return jsBundle;
  return jsBundle.slice(0, m.index + m[0].length);
}

function bufferReplaceAll(buf, src, dst) {
  const parts = [];
  let last = 0;
  while (true) {
    const next = buf.indexOf(src, last);
    if (next < 0) { parts.push(buf.slice(last)); break; }
    parts.push(buf.slice(last, next));
    parts.push(dst);
    last = next + src.length;
  }
  return Buffer.concat(parts);
}

function applyNodePatches(jsBundle, embeddedDir) {
  let out = jsBundle;
  // 1. /$bunfs/root/ → embedded dir
  out = bufferReplaceAll(
    out,
    PATH_PREFIX_BYTES,
    Buffer.from(embeddedDir.replace(/\/+$/, '') + '/', 'utf8'),
  );
  // 2. import.meta.require → globalThis.__bunRequire (length-preserved-ish)
  out = bufferReplaceAll(
    out,
    Buffer.from('import.meta.require', 'utf8'),
    Buffer.from('globalThis.__bunRequire', 'utf8'),
  );
  // 3. "bun:ffi" → "<SHIM_DIR>/bun-ffi.mjs"
  out = bufferReplaceAll(
    out,
    Buffer.from('"bun:ffi"', 'utf8'),
    Buffer.from(`"${join(SHIM_DIR, 'bun-ffi.mjs')}"`, 'utf8'),
  );
  // 4. "bun:jsc" → "<SHIM_DIR>/bun-jsc.mjs"
  out = bufferReplaceAll(
    out,
    Buffer.from('"bun:jsc"', 'utf8'),
    Buffer.from(`"${join(SHIM_DIR, 'bun-jsc.mjs')}"`, 'utf8'),
  );
  // 5. this.server=Bun.serve( → this.server=await Bun.serve(  (DaemonServer only)
  out = bufferReplaceAll(
    out,
    Buffer.from('this.server=Bun.serve(', 'utf8'),
    Buffer.from('this.server=await Bun.serve(', 'utf8'),
  );
  // 6. `from"ws"` -> absolute path to the ws package we ship as a dep.
  //    Bundle has a single static `import X from "ws"` to set global.WebSocket;
  //    resolving it from the cache dir would fail (no node_modules there).
  //    We resolve once at extract time and bake in the absolute path.
  try {
    const wsEntry = require.resolve('ws');
    out = bufferReplaceAll(
      out,
      Buffer.from('from"ws"', 'utf8'),
      Buffer.from(`from"${wsEntry}"`, 'utf8'),
    );
  } catch {
    // ws not installed — bundle will throw at module load; that's OK if user
    // never reaches the code path. We don't fail extraction.
  }
  return out;
}

export function isExtracted(dir) {
  return existsSync(join(dir, 'droid.node.mjs')) && existsSync(join(dir, '.complete'));
}

export function extract(binaryPath, dir, { quiet = false } = {}) {
  const embedded = join(dir, 'embedded');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(embedded, { recursive: true });

  const log = (...args) => { if (!quiet) console.error('[droidnode]', ...args); };

  log(`reading ${binaryPath}`);
  const buf = readFileSync(binaryPath);
  const sectionStart = findBunSection(buf);
  log(`bundle section starts at 0x${sectionStart.toString(16)}`);

  const entries = findFileEntries(buf, sectionStart);
  log(`found ${entries.length} embedded entries`);

  let droidEntry = null;
  for (const e of entries) {
    const base = e.path.slice(BUNFS_PREFIX.length);
    const raw = buf.slice(e.contentStart, e.contentEnd);
    if (base === 'droid') {
      droidEntry = { ...e, raw };
      continue;
    }
    const outPath = join(embedded, base);
    writeFileSync(outPath, raw);
    if (/^(rg-|agent-browser-|librust_pty-|rust_pty)/.test(base) || /\.sh-/.test(base)) {
      chmodSync(outPath, 0o755);
    }
  }
  if (!droidEntry) throw new Error('droid JS bundle entry missing from .bun section');

  log(`applying Node patches (paths, bun: shims, import.meta.require, Bun.serve async)`);
  let bundle = trimBundleAtDebugId(droidEntry.raw);
  bundle = applyNodePatches(bundle, embedded);
  // .mjs so Node treats it as ESM unconditionally (cache dir has no package.json)
  writeFileSync(join(dir, 'droid.node.mjs'), bundle);

  writeFileSync(join(dir, '.complete'), `${Date.now()}\n${binaryPath}\nshims=${SHIM_DIR}\n`);
  log(`extracted ${entries.length} files → ${dir}`);
  return dir;
}

export function ensureExtracted(binaryPath, { quiet = false } = {}) {
  const dir = cacheDirFor(binaryPath);
  if (isExtracted(dir)) return dir;
  return extract(binaryPath, dir, { quiet });
}

export { SHIM_DIR, PKG_ROOT };
