# @thezzisu/droidnode

A thin Node-side launcher for [Factory's `droid` CLI](https://www.npmjs.com/package/droid). It extracts the JS bundle from the published droid binary and runs it under a separately-installed [Bun](https://bun.sh), bypassing a NULL-allocator race in Bun 1.3.x's standalone-init path that causes `droid --resume` to segfault on long sessions.

> **droid is © Factory AI.** This repository ships zero proprietary code — no JS bundle, no native binaries, no assets. We depend on the official `droid` npm package as the sole source of truth. All this wrapper does is invoke Bun against the bundle Factory shipped instead of letting Factory's `bun build --compile` standalone init run. **All trademarks and copyrights belong to their respective owners.**

## What this fixes

`droid --resume <id>` on a sufficiently large mission session crashes with:

```
panic(main thread): Segmentation fault at address 0x00000000
[1]    XXXXX illegal hardware instruction (core dumped)
```

Decoded backtrace ([bun.report](https://bun.report)):

```
Allocator.zig:129    mem.Allocator.rawAlloc                  ← NULL vtable.alloc
array_list.zig:57    AlignedManaged.initCapacity
unicode.zig:315      string.immutable.unicode.toUTF8AllocWithType
encoding.zig:483     bun.js.webcore.encoding.constructFromU16
encoding.zig:63      Bun__encoding__constructFromUTF16
JSBuffer.cpp:551     WebCore::constructFromEncoding
JSHash.cpp:182       Bun::jsHashProtoFuncUpdate              ← crypto hash.update(<string>)
<JS>                 session resume / digest pipeline
```

The race only fires inside Bun's standalone-executable init under spawn/fanout pressure (large mission with many subagents, ~4 s into startup). Running the same JS bundle through a normal `bun` process — which never enters that init path — sidesteps it entirely. See related upstream reports: [oven-sh/bun#25798](https://github.com/oven-sh/bun/issues/25798), [oven-sh/bun#14254](https://github.com/oven-sh/bun/issues/14254), [anthropics/claude-code#17546](https://github.com/anthropics/claude-code/issues/17546).

## Install

```bash
npm install -g @thezzisu/droidnode
```

Or run ad-hoc:

```bash
npx -y @thezzisu/droidnode --resume <session-id>
```

`droid` and `bun` are both regular dependencies — npm pulls them in. If you already have `droid` installed globally and want to use your own copy, set `DROID_BIN=/path/to/droid` and that takes precedence.

## Use

```bash
droidnode --version              # 0.140.0 (matches droid)
droidnode --help                 # full droid help
droidnode --resume <id>          # the case this exists for
droidnode --fork <id>            # forks
droidnode exec "do thing"        # non-interactive
```

It accepts every flag/subcommand the real `droid` does — argv is passed through.

### Introspection

```bash
droidnode --print-paths          # JSON: which droid binary, bun, cache dir
droidnode --reextract            # blow away the cache and re-extract
```

### Environment

| Variable | Purpose |
|---|---|
| `DROID_BIN` | Override droid binary location |
| `BUN_BIN` | Override bun binary location |
| `DROIDNODE_VERBOSE` | Print extraction progress on first run |
| `XDG_CACHE_HOME` | Cache base (defaults to `~/.cache`) |

Cache lives at `$XDG_CACHE_HOME/droidnode/<binary-fingerprint>/`. Multiple droid versions get separate caches automatically.

## Versioning

`@thezzisu/droidnode@X.Y.Z` is built against `droid@X.Y.Z`. When Factory ships a new droid we bump in lockstep. Patch suffixes on the wrapper itself, if needed, are appended as `X.Y.Z-shim.N` so that range queries against `droid` keep working.

## Platform support

Verified: **Linux x64** (the configuration that hits the bug hardest, especially under WSL2). The extractor is platform-agnostic and `darwin-arm64`/`darwin-x64` are wired in `package.json` — community testing welcome.

Windows is not supported in this release. droid's standalone uses a different process model on win32 and we haven't reproduced or fixed the same crash there.

## How it works

1. Resolve `droid` via `require('droid/platform.js').getBinaryPathWithInfo()` (the same logic Factory's own shim uses), giving the `@factory/cli-<platform>` binary path.
2. Parse the `.bun` ELF section: scan for `/$bunfs/root/` path entries packed sequentially as `<path>\0<content>`.
3. For each non-`droid` entry, write to `<cache>/embedded/<basename>` and chmod +x natives.
4. For the `droid` JS bundle: rewrite every `/$bunfs/root/` literal to absolute paths inside `<cache>/embedded/`, then truncate the file after the `//# debugId=<hex>\n` marker (Bun appends raw Zstd-compressed sourcemap blobs past that point that fail to parse as JS).
5. `spawnSync(bun, ['--preload', preload.js, droid.js, ...argv])`. The preload installs `process.execPath`/`argv0`/`argv[0]` overrides so droid's self-spawn (subagents, post-update restart) re-enters us.

Subsequent invocations hit the cache and skip extraction.

## Limitations

- Subagent fanout in long missions hasn't been stress-tested end-to-end. Session restore + UI/Plan reload are confirmed working.
- `droid update` (the in-place updater) tries to overwrite its own binary. Through this wrapper it overwrites the resolved npm package binary, which generally Just Works for npm-managed installs but may surprise standalone users.
- `keytar`-backed credential storage uses droid's existing fallback on Linux; the wrapper does not provide it separately.

## License

Wrapper code (`bin/`, `lib/`, `src/`, this README) is MIT — see [LICENSE](./LICENSE).

**The droid CLI, its JS bundle, the `@factory/cli-*` binaries, and all related Factory AI intellectual property are not covered by this license** and remain subject to Factory's own terms. This project does not redistribute any of it.

## Acknowledgements

- Factory AI — the actual CLI we're patching around.
- The oven-sh/bun team — fixing this upstream eventually will retire this shim.
