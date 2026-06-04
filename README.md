# @thezzisu/droidnode

A Node.js-side launcher for [Factory's `droid` CLI](https://www.npmjs.com/package/droid). It extracts the JS bundle from the official droid binary and runs it under plain Node — not Bun — to sidestep two long-standing Bun 1.3.x issues that hurt droid users on long sessions:

1. **NULL-allocator race in standalone init.** `droid --resume <id>` of a large mission session crashes with `Segmentation fault at address 0x0` — Bun's standalone fork/fanout pressure leaves `bun.default_allocator` with a NULL vtable, and the first `hash.update(<long string>)` call segfaults inside `Allocator.rawAlloc`. Backtrace decoded from [bun.report](https://bun.report):

   ```
   Allocator.zig:129   mem.Allocator.rawAlloc            ← NULL vtable.alloc
   array_list.zig:57   AlignedManaged.initCapacity
   unicode.zig:315     toUTF8AllocWithType
   encoding.zig:483    bun.js.webcore.encoding.constructFromU16
   encoding.zig:63     Bun__encoding__constructFromUTF16
   JSBuffer.cpp:551    WebCore::constructFromEncoding
   JSHash.cpp:182      Bun::jsHashProtoFuncUpdate        ← hash.update(<string>)
   <JS>                droid session-resume / digest pipeline
   ```

   Related upstream reports: [oven-sh/bun#25798](https://github.com/oven-sh/bun/issues/25798), [oven-sh/bun#14254](https://github.com/oven-sh/bun/issues/14254), [anthropics/claude-code#17546](https://github.com/anthropics/claude-code/issues/17546). The race only fires inside Bun's standalone-executable init under spawn pressure; running the same JS bundle through a fresh Bun (or Node) process never enters that path.

2. **Bun memory growth on long-lived sessions.** Mission-mode droid sessions running for hours accumulate RSS in Bun beyond what the bundle's logical heap explains. Node + V8 doesn't exhibit the same drift.

> **droid is © Factory AI.** This repository ships zero proprietary code — no JS bundle, no native binaries, no assets. We depend on the official `droid` npm package as the sole source of truth and apply a small set of Node-compat patches at extraction time. **All trademarks and copyrights belong to their respective owners.**

## Install

```bash
npm install -g @thezzisu/droidnode
```

Or run ad-hoc (downloads droid + @factory/cli-<platform> + koffi the first time):

```bash
npx -y @thezzisu/droidnode --resume <session-id>
```

Both forms transparently install the `droid` npm package as a dependency, so a separate `npm install -g droid` is not required.

## Use

```bash
droidnode --version           # tracks the underlying droid version
droidnode --help              # full droid help (passthrough)
droidnode --resume <id>       # the case this exists for
droidnode --fork <id>         # forks
droidnode exec "do thing"     # non-interactive
```

Every droid flag/subcommand is passed through verbatim.

### Introspection

```bash
droidnode --print-paths       # JSON: resolved droid binary, Node, shim dir, cache dir
droidnode --reextract         # wipe the cache for the current droid binary and re-extract
```

### Environment

| Variable | Purpose |
|---|---|
| `DROID_BIN` | Override droid binary location |
| `DROIDNODE_VERBOSE` | Print extraction progress on first run |
| `XDG_CACHE_HOME` | Cache base (defaults to `~/.cache`) |

Cache lives at `$XDG_CACHE_HOME/droidnode/<binary-fingerprint>/`. The key includes the droid binary's size + head/tail hash + the shim directory path, so multiple droid versions and multiple `droidnode` installs coexist without collisions.

## How it works

1. Resolve `droid` via `require('droid/platform.js').getBinaryPathWithInfo()` — the same logic Factory's own shim uses, picking `@factory/cli-<platform>{,-baseline}` based on the host CPU's AVX2 support.
2. Locate the `.bun` ELF section by scanning for the `/$bunfs/root/droid\0// @bun\n` opener. Files inside are packed sequentially as `<path>\0<content>`; we walk the list by looking for `\0/$bunfs/root/` boundaries.
3. Extract every non-`droid` entry to `<cache>/embedded/<basename>` and chmod +x the natives (`rg`, `librust_pty-*.so`, `agent-browser`, install shell scripts).
4. Apply the following patches to the JS bundle and write it as `<cache>/droid.node.mjs`:
   - Truncate at the last `//# debugId=<hex>\n` line. Bun appends raw Zstd sourcemap blobs past it that fail Node's JS parser on the embedded NULL bytes.
   - Replace every `/$bunfs/root/` literal with the absolute path to `<cache>/embedded/`.
   - `import.meta.require` → `globalThis.__bunRequire` (installed by `bun-shim.mjs`; Node has no `import.meta.require`).
   - `"bun:ffi"` → absolute path to `src/shims/bun-ffi.mjs` (koffi-backed dlopen for the PTY .so).
   - `"bun:jsc"` → absolute path to `src/shims/bun-jsc.mjs` (empty `heapStats` stub; droid only calls it inside try/catch).
   - `from"ws"` → absolute path to the `ws` package's entry (so the bundle's `import X from "ws"` resolves outside any `node_modules` tree).
   - `this.server=Bun.serve(` → `this.server=await Bun.serve(` ×2. Our Bun.serve polyfill is async; Bun's original is sync.
5. Spawn `node --import bun-shim.mjs --enable-source-maps <cache>/droid.node.mjs <argv>`. The shim preload:
   - Overrides `process.execPath` / `argv0` / `argv[0]` so droid's self-spawn (subagent fanout, restart-after-update) re-enters us via `basename(execPath).includes("droid")`.
   - Installs `globalThis.Bun` with subset of `spawn`/`spawnSync`/`file`/`which`/`gc`/`connect`/`serve`/`fileURLToPath`/`version`.
   - Implements `Bun.serve` over `node:http` + `ws` (the only thing `droid daemon` needs that Bun has and Node doesn't).
   - Routes `import.meta.require` through `createRequire(import.meta.url)`, intercepting `node-fetch` and `abort-controller` to the Node 18+ / 15+ globals so neither package needs to be installed.
   - Aliases `Buffer.SlowBuffer = Buffer` (Node 22+ removed `SlowBuffer`; the bundled `buffer-equal-constant-time` still references it).

Subsequent invocations hit the cache and skip extraction.

## Cross-version compatibility

The patch set is stable across the droid versions we've tested (0.135.1 through 0.140.0 — every published version we could install at the time). The CI smoke job runs extraction + `--version` on every push; the `auto-track` workflow re-runs it daily against the latest droid release before bumping our pin.

Despite the patches being stable, the `dependencies.droid` range is pinned to `^<latest-tested>` so a stale install never silently runs against an untested droid major. The bot opens a new tag/release whenever upstream droid moves.

## Automation

- `.github/workflows/ci.yml` — runs `scripts/smoke.js` (extract + `--version`) on Node 20 and 22, on every push and PR.
- `.github/workflows/auto-track.yml` — runs daily; if `npm view droid version` exceeds our `package.json` version, runs the smoke against the new droid, bumps both `version` and `dependencies.droid`, commits to `main`, tags `v<version>`, creates a GitHub release, and (if `NPM_TOKEN` is set as a repo secret) publishes to npm with provenance.

To enable auto-publish: add `NPM_TOKEN` under repo secrets. Without it, releases are tagged on GitHub only — users can still `npm install` from the tarball URL or run the previous published version.

## Platform support

Verified: **Linux x64** (the configuration that hits the bug hardest, especially under WSL2). The extractor and shims are platform-agnostic; `darwin-arm64` and `darwin-x64` are wired in `package.json` — community testing welcome.

Windows is not supported in this release. droid's standalone uses a different process model on win32 and we haven't reproduced or fixed the same crash there.

## Limitations

- Subagent fanout in long missions hasn't been stress-tested end-to-end. Session restore + UI/Plan reload + cwd restoration are confirmed working.
- `droid update` (the in-place updater) tries to overwrite its own binary. Through this wrapper it would target the resolved `@factory/cli-*/bin/droid` inside our `node_modules`; for npm-managed installs `npm update -g @thezzisu/droidnode` is the supported upgrade path.
- `keytar`-backed credential storage uses droid's own Linux fallback when keytar can't load (the bundle wraps it in try/catch). The wrapper does not provide it separately.

## License

Wrapper code (`bin/`, `lib/`, `src/`, `scripts/`, this README) is MIT — see [LICENSE](./LICENSE).

**The droid CLI, its JS bundle, the `@factory/cli-*` binaries, and all related Factory AI intellectual property are not covered by this license** and remain subject to Factory's own terms. This project does not redistribute any of it.

## Acknowledgements

- Factory AI — the actual CLI we're patching around.
- The oven-sh/bun team — fixing this upstream eventually will retire this shim.
