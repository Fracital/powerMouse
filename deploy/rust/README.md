# deploy/rust: the toolchain for every Rust/wasm artifact

Every piece of stomp written in Rust and run as wasm (the JS rewriter, the
CSS rewriter and markup scanner, the blocker, WebRTC over wisp; docs/rust-plan.md) is a crate under `rust/` and
is built here, in one pinned container, into a committed artifact under
`assets/` that `build.js` copies into `dist/`. There is no Rust toolchain on
CI, on the deploy or on terp, and `dist/` is wiped on every build, so the
artifact must be committed: a change to a crate is a change to its artifact
in the same commit.

```sh
deploy/rust/build.sh <crate> <name>    # e.g. build.sh rwjs rewriter
```

gives `assets/<name>.wasm`, `assets/<name>.wasm.sha256` and
`assets/<name>.UPSTREAM` (the crate, a hash of its sources, the toolchain
image and every pin). The `sources` hash is of what that crate's build
takes in and nothing else (`inputs.sh`, run in the container): the crate's
own files, those of the workspace crates it depends on by path (`rwjs`
builds `rust/edits` in), the dependency set cargo resolves for it
(`cargo tree -p <crate> --locked`, with features), the release profile,
`pins.env` and the build scripts. So an artifact's line changes when its
bytes could, and adding a crate to the workspace or touching another
crate's sources or dependencies leaves it alone.
`ONLY_SOURCES=1 deploy/rust/build.sh <crate> <name>` builds nothing and
prints the line the tree as it stands would get, to hold against the one
committed. The first run builds the toolchain image (a few
minutes); later runs reuse it until `pins.env` or the `Dockerfile` changes.
Where docker's bridge network cannot reach the Rust mirrors, set `ENGINE` to
a wrapper that adds `--network host` to `docker build`, as for
`deploy/epoxy`.

## Adding a crate

The crates that share this toolchain build two artifacts today: the core
module (`rust/core-module`, `core.wasm`: the JS rewriter `rwjs`, the CSS
rewriter and markup scanner `rwcss` and the public suffix lookup `suffix`,
each a plain library it builds in, behind one export table) and the
blocker (`rust/block`, `blocker.wasm`), which only the service worker runs
and only with the blocker on. A new piece that every context running
`rewriter: 'wasm'` wants (the URL codec) is a member of the core: a library
crate, a module in `rust/core-module/src/` with its exports under a letter
of their own, its lines in `rust/core-module/abi.json`, and a view in
`MEMBERS` (`src/wasm/module.ts`). A new artifact follows this recipe:

1. A directory `rust/<crate>/` with a `cdylib` crate, added to the
   workspace `members` in `rust/Cargo.toml`, and `LOCK=1 build.sh <crate>
<name>` once to resolve its dependencies into the committed
   `rust/Cargo.lock`.
2. `rust/<crate>/abi.json`: the imports (`module.field`) and exports
   (`name:kind`) the artifact may have, and nothing else. A crate that
   speaks the buffer ABI (`rust/block/src/lib.rs` is the model) is loaded
   with the few lines of `src/blocker/instance.ts`; one that needs WASI
   names those imports here and answers them in its worker.
3. The markers, if any: `wasm-target`, `bindgen` (below).
4. A key in `Assets` and `DEFAULT_ASSETS` (`src/config.ts`) naming
   `<name>.wasm`, so a host that renames files can say what it called it,
   and a line in `README.md`'s `init.assets` row.
5. `build.sh <crate> <name>`. `build.js` copies everything in `assets/`
   into `dist/`, and the `wasm-artifact` suite checks every artifact it
   finds there against its crate's `abi.json`, so nothing else registers
   the artifact.

A crate built from data keeps the data in its `src/` and pins it there:
the suffix crate's table is made by its `build.rs` from
`rust/suffix/src/public_suffix_list.dat`, vendored byte for byte from the
publicsuffix/list repository at the commit `rust/suffix/src/pins.env`
names, with the file's sha256 (`build.rs` stops on any other file). Under
`src/` both are among the crate's files in its `sources` line, and
`build.sh` writes the `src/pins.env` of every crate an artifact builds in
into its `UPSTREAM` after the toolchain's pins. The toolchain image does not change with them,
so a new list rebuilds one artifact and changes no other's line.

What the crates share in Rust is `rust/edits`: the span edit model and the
splice engine (`Edit::wrap`, `Edit::replace`, `Edit::insert`, `apply`), for
any rewriter that edits text at byte spans. Its API is the handful of items
its `lib.rs` documents; it depends on nothing.

## What is pinned, and how

`pins.env` holds all of it:

- the Rust image by digest (`rustlang/rust@sha256:...`), which pins the
  nightly; `compile.sh` asserts the image's `rustc --version` names the
  nightly `RUST_NIGHTLY` records, so a wrong image fails before it builds.
- binaryen and the wasm-bindgen CLI by release and by sha256 of the tarball,
  checked before they are unpacked. (`deploy/epoxy`'s image floats its base
  tag and does not check its downloads; this one does both, because the
  artifact's bytes are committed and must be reproducible.)
- the `wasm-snip` CLI by version (`WASM_SNIP`), built from crates.io source
  with its own committed lockfile (`--locked`); it ships no binary release to
  checksum.
- `rust/Cargo.lock`, committed, and `--locked` builds.
- a crate built with a patch of STomp's (`rust/patches/crates`: name,
  version, sha256 of the `.crate` file crates.io serves, which is the
  checksum `Cargo.lock` had for it). `patches.sh` runs in the container
  before cargo: it downloads the crate once into the registry volume, checks
  it, unpacks it to `rust/patched/<name>` (not committed) and applies
  `rust/patches/<name>-<version>.patch`; `rust/Cargo.toml` points
  `[patch.crates-io]` there. A patch that no longer applies fails the build,
  and the patched crate is a path dependency, so its files, patch applied,
  are among the crate's in the `sources` line of `UPSTREAM`.

## How a crate is built

`compile.sh` runs in the container: `cargo build --release` for wasm32 with
the standard library rebuilt (`-Z build-std=std,panic_abort`, optimized for
size) under `-Zlocation-detail=none -Zfmt-debug=none`, so no panic location,
source path or Debug formatting reaches the bytes; the workspace profile is
`opt-level = "z"`, `lto`, one codegen unit, `panic = "abort"`, stripped.
Then `wasm-opt -Oz --converge` (the passes rerun until the bytes stop
shrinking) with the debug, producers and target-features sections stripped.

Four per-crate markers, each a file in `rust/<crate>/`:

- `wasm-target`, holding a target triple, builds for that target instead of
  `wasm32-unknown-unknown`. The image has `wasm32-wasip1` too, for a crate
  that needs a clock and randomness from the host (the WebRTC stack): its
  worker answers the few WASI imports with a small shim, and its `abi.json`
  lists them.
- `rustflags`, extra flags for this crate's `cargo build` (the WebRTC stack
  and the core module take `-Zunstable-options -Cpanic=immediate-abort`, so a
  panic is a bare trap and its unwinding and message machinery leaves the
  bytes).
- `snip`, regexes (one per line, `#` and blank lines ignored) of functions
  `wasm-snip` replaces with `unreachable` before `wasm-opt`, so the
  optimizer's dead-code pass drops them and all they reach. The core module
  lists oxc's JSX and TypeScript-node paths, which a JS-only rewrite never
  enters (see `rust/core-module/snip`). A crate with this marker builds
  `-Cstrip=none` so the name section survives to `wasm-snip`; `wasm-opt
--strip-debug` still removes it from the shipped artifact.
- `bindgen`, empty, runs `wasm-bindgen --target web` on the output and ships
  the glue beside the module with every `import.meta.url` in it replaced,
  because the glue must never name its own file.

The rewriter uses no `bindgen`: its boundary is byte buffers under
single-letter names (`rust/rwjs/src/lib.rs`, `src/wasm/module.ts`), which a
host can rename and substitute at the same length.

## What an artifact may look like

`check.mjs` reads the bytes and fails the build on:

- any custom section (a `name` or `producers` section carries crate and
  function names);
- an import or export the crate's `abi.json` does not declare, or one it
  declares missing;
- any of the tokens a host's canary scan refuses (`stomp`, `scramjet`,
  `epoxy`, `fracital`, ... and the build's own `rustc`, `library/`, `.rs`,
  `panicked`, `/home/`, `/work/`), anywhere in the bytes read as latin1.

The suite `wasm-artifact` runs the same checks on what `dist/` ships and
loads each artifact through `src/wasm/module.ts`.

## Loading

`src/wasm/module.ts`: `compileModule` takes a URL, bytes, a Response or a
module the host compiled itself (a host that decrypts or renames its wasm
hands the result over), never reads `import.meta.url`, and compiles once;
the compiled `WebAssembly.Module` is what crosses to the rewrite workers and
the page's library realm, each of which instantiates it synchronously. The
service worker is an agent cluster of its own and cannot be posted a
module: it is handed the bytes and compiles them (`src/wasm/thread.ts`).
`CoreInstance` is one instance of the core and a `BufferInstance` view of
it per member (`MEMBERS`: which export each role is read from), each
speaking the buffer ABI: strings in and out, one `configure` per change, a
routing import of its own the host answers.
