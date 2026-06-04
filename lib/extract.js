// Extract the JS bundle and embedded resources from a droid Bun-standalone binary.
//
// Bun's `bun build --compile` lays the bundle into a dedicated `.bun` ELF
// section. Inside that section files are packed sequentially as
// `<path>\0<content><next-path>\0<content>...` plus a trailing index that
// we don't strictly need — we walk the packed list by scanning for the
// `/$bunfs/` path prefix.
//
// Two transformations are required before bun can run droid.js as a plain
// script:
//   1. Substitute every `/$bunfs/root/` reference with the absolute path
//      of the extraction directory, so embedded assets resolve.
//   2. Truncate the bundle right after `//# debugId=<hex>\n` — Bun appends
//      Zstd-compressed sourcemap blobs as raw bytes after that line, which
//      bun-as-interpreter parses as JS and chokes on the NULL bytes.

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const BUNFS_PREFIX = '/$bunfs/root/';
const PATH_PREFIX_BYTES = Buffer.from(BUNFS_PREFIX, 'utf8');

function cacheKeyFor(binaryPath) {
  const st = statSync(binaryPath);
  // Sample the head, tail, and size — enough to detect any version bump
  // without hashing 150 MB.
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
  return h.digest('hex').slice(0, 16);
}

export function cacheRootDir() {
  // XDG cache home with sensible fallback
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : join(homedir(), '.cache');
  return join(base, 'droidnode');
}

export function cacheDirFor(binaryPath) {
  return join(cacheRootDir(), cacheKeyFor(binaryPath));
}

function findBunSection(buf) {
  // Find the start of the embedded bundle: the path string `/$bunfs/root/droid\0`
  // is the very first entry of the `.bun` section. We don't fully parse ELF
  // headers — searching for this exact opener is robust across droid releases.
  const needle = Buffer.from(BUNFS_PREFIX + 'droid\0// @bun\n', 'utf8');
  const idx = buf.indexOf(needle);
  if (idx < 0) throw new Error('embedded bundle not found — is this really a droid Bun standalone?');
  return idx;
}

function findFileEntries(buf, startOffset) {
  // Walk all positions where `\0/$bunfs/root/` appears (file boundary).
  // The very first entry has no leading NULL because it sits at the start
  // of the section, so we seed with `startOffset`.
  const entries = [{ pathStart: startOffset }];
  let from = startOffset + 1;
  while (true) {
    const next = buf.indexOf(PATH_PREFIX_BYTES, from);
    if (next < 0) break;
    // Validate: must be preceded by NULL byte (a content terminator)
    if (next === 0 || buf[next - 1] !== 0) {
      from = next + 1;
      continue;
    }
    entries.push({ pathStart: next });
    from = next + 1;
  }
  // Resolve path string + content slice for each entry
  const resolved = [];
  for (let i = 0; i < entries.length; i++) {
    const pStart = entries[i].pathStart;
    const pEnd = buf.indexOf(0, pStart);
    if (pEnd < 0) break;
    const path = buf.slice(pStart, pEnd).toString('utf8');
    const contentStart = pEnd + 1;
    const contentEnd = (i + 1 < entries.length) ? entries[i + 1].pathStart : -1;
    if (contentEnd < 0) {
      // Last entry — bound by section end; conservatively read until end of buffer.
      // The trailing index region adds noise but we only consume what we need.
      resolved.push({ path, contentStart, contentEnd: buf.length });
    } else {
      resolved.push({ path, contentStart, contentEnd });
    }
  }
  return resolved;
}

function trimBundleAtDebugId(jsBundle) {
  // Bun appends raw Zstd-compressed sourcemap blobs after the last
  // `//# debugId=<hex>\n` line. Cut there.
  const m = jsBundle.toString('binary').match(/\/\/# debugId=[0-9A-Fa-f]+\n/);
  if (!m) return jsBundle; // No marker — leave as-is, may fail to parse
  const cut = m.index + m[0].length;
  return jsBundle.slice(0, cut);
}

function patchBundlePaths(jsBundle, extractedDir) {
  // Replace every `/$bunfs/root/` literal with the absolute path to the
  // extracted directory. Length change is harmless — JS doesn't depend on
  // byte offsets within the source.
  const dst = Buffer.from(extractedDir.replace(/\/+$/, '') + '/', 'utf8');
  // Buffer doesn't have a global replace — do it manually
  const parts = [];
  let last = 0;
  while (true) {
    const next = jsBundle.indexOf(PATH_PREFIX_BYTES, last);
    if (next < 0) { parts.push(jsBundle.slice(last)); break; }
    parts.push(jsBundle.slice(last, next));
    parts.push(dst);
    last = next + PATH_PREFIX_BYTES.length;
  }
  return Buffer.concat(parts);
}

export function isExtracted(dir) {
  return existsSync(join(dir, 'droid.js')) && existsSync(join(dir, '.complete'));
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
      continue; // Written separately after path patching
    }
    const outPath = join(embedded, base);
    writeFileSync(outPath, raw);
    // Make native binaries executable
    if (/^(rg-|agent-browser-|librust_pty-|rust_pty)/.test(base) || base.endsWith('.sh') || /\.sh-/.test(base)) {
      chmodSync(outPath, 0o755);
    }
  }
  if (!droidEntry) throw new Error('droid JS bundle entry missing');

  log(`patching paths and trimming sourcemap blob`);
  let bundle = patchBundlePaths(droidEntry.raw, embedded);
  bundle = trimBundleAtDebugId(bundle);
  writeFileSync(join(dir, 'droid.js'), bundle);

  writeFileSync(join(dir, '.complete'), `${Date.now()}\n${binaryPath}\n`);
  log(`extracted ${entries.length} files to ${dir}`);
  return dir;
}

export function ensureExtracted(binaryPath, { quiet = false } = {}) {
  const dir = cacheDirFor(binaryPath);
  if (isExtracted(dir)) return dir;
  return extract(binaryPath, dir, { quiet });
}
