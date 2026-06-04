// Loaded by `bun --preload` before the droid bundle runs.
//
// droid's spawn logic has a dev-mode branch that requires
// `basename(process.execPath).includes("droid")` to hold true; otherwise
// it falls back to literally invoking `"droid"`/`"droid-dev"` by name.
// Since we run under `bun`, the real execPath ends in `bun` — we override
// it so self-spawn picks the wrapper binary the user invoked us through.

const wrapperPath = process.env.DROIDNODE_WRAPPER_PATH;
if (wrapperPath) {
  try {
    Object.defineProperty(process, 'execPath', { value: wrapperPath, configurable: true });
  } catch { /* sealed runtime — argv0 alone will have to do */ }
  try {
    Object.defineProperty(process, 'argv0', { value: 'droid', configurable: true });
  } catch { /* same */ }
  if (Array.isArray(process.argv) && process.argv.length > 0) {
    process.argv[0] = wrapperPath;
  }
}
