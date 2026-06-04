// Shim for `import { dlopen, FFIType, ptr } from "bun:ffi"`
// Backed by koffi so droid's PTY (librust_pty-*.so) loads under plain Node.
//
// Bun's FFI API contract used by droid (see droid.js @ ~6549438):
//   dlopen(path, { fnName: { args:[FFIType.*], returns: FFIType.* } })
//     → { symbols: { fnName: callable }, close() }
//   FFIType.cstring / .pointer / .i32 / .void  → koffi type strings
//   ptr(buffer)  → returns a native pointer / koffi pointer wrapper
//
// librust_pty-*.so ABI notes (probed against the bundled Linux .so):
//   bun_pty_write(id, ptr, len) -> i32:  0 = submitted, -1 = error (invalid id/NULL buf/neg len)
//                                        NOT a byte count; droid ignores the return value.
//   bun_pty_read (id, ptr, len) -> i32:  >0 = bytes read, -1 = invalid id, -2 = would-block (no data)
//   bun_pty_spawn(...)          -> i32:  >=1 = pty_id, -1 = error
//   bun_pty_get_pid / _exit_code / _kill / _resize  -> i32 status
//   bun_pty_close(id)           -> void

import koffi from 'koffi';

// Map Bun's FFIType enum → koffi type names
export const FFIType = Object.freeze({
  void:      'void',
  i8:        'int8_t',
  u8:        'uint8_t',
  i16:       'int16_t',
  u16:       'uint16_t',
  i32:       'int32_t',
  u32:       'uint32_t',
  i64:       'int64_t',
  u64:       'uint64_t',
  f32:       'float',
  f64:       'double',
  bool:      'bool',
  ptr:       'void *',
  pointer:   'void *',
  cstring:   'const char *',
  buffer:    'void *',
  char:      'char',
});

export function dlopen(libPath, defs) {
  const lib = koffi.load(libPath);
  const symbols = {};
  for (const [name, spec] of Object.entries(defs)) {
    const ret = FFIType[spec.returns] ?? spec.returns ?? 'void';
    const args = (spec.args || []).map(a => FFIType[a] ?? a);
    symbols[name] = lib.func(name, ret, args);
  }
  return {
    symbols,
    close() { try { lib.unload?.(); } catch {} },
  };
}

// Bun's ptr(buf) returns an opaque pointer value. koffi accepts Buffer/Uint8Array
// directly for `void *` params, so the identity is enough for droid's call sites
// (write/read pass a Buffer to a void* arg).
export function ptr(buf) {
  return buf;
}

export default { dlopen, FFIType, ptr };
