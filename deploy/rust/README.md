# deploy/rust: the toolchain for every Rust/wasm artifact

Every piece of stomp written in Rust and run as wasm (the JS rewriter, the
CSS and markup scanner, the blocker, WebRTC over wisp; docs/rust-plan.md) is a crate under `rust/` and
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
image and every pin). The first run builds the toolchain image (a few
minutes); later runs reuse it until `pins.env` or the `Dockerfile` changes.
Where docker's bridge network cannot reach the Rust mirrors, set `ENGINE` to
a wrapper that adds `--network host` to `docker build`, as for
`deploy/epoxy`.

## Adding a crate

Four crates share this toolchain (the rewriter, the scanner, the blocker,
WebRTC), and
the recipe is the same for each:

1. A directory `rust/<crate>/` with a `cdylib` crate, added to the
   workspace `members` in `rust/Cargo.toml`, and `LOCK=1 build.sh <crate>
<name>` once to resolve its dependencies into the committed
   `rust/Cargo.lock`.
2. `rust/<crate>/abi.json`: the imports (`module.field`) and exports
   (`name:kind`) the artifact may have, and nothing else. A crate that
   speaks the buffer ABI (`rust/rwjs/src/abi.rs` is the model) is loaded by
   `src/wasm/module.ts`'s `BufferInstance` with no glue of its own; one
   that needs WASI names those imports here and answers them in its worker.
3. The markers, if any: `wasm-target`, `bindgen` (below).
4. A key in `Assets` and `DEFAULT_ASSETS` (`src/config.ts`) naming
   `<name>.wasm`, so a host that renames files can say what it called it,
   and a line in `README.md`'s `init.assets` row.
5. `build.sh <crate> <name>`. `build.js` copies everything in `assets/`
   into `dist/`, and the `wasm-artifact` suite checks every artifact it
   finds there against its crate's `abi.json`, so nothing else registers
   the artifact.

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
- `rust/Cargo.lock`, committed, and `--locked` builds.

## How a crate is built

`compile.sh` runs in the container: `cargo build --release` for wasm32 with
the standard library rebuilt (`-Z build-std=std,panic_abort`, optimized for
size) under `-Zlocation-detail=none -Zfmt-debug=none`, so no panic location,
source path or Debug formatting reaches the bytes; the workspace profile is
`opt-level = "z"`, `lto`, one codegen unit, `panic = "abort"`, stripped.
Then `wasm-opt -Oz` with the debug, producers and target-features sections
stripped.

Two per-crate markers, each a file in `rust/<crate>/`:

- `wasm-target`, holding a target triple, builds for that target instead of
  `wasm32-unknown-unknown`. The image has `wasm32-wasip1` too, for a crate
  that needs a clock and randomness from the host (the WebRTC stack): its
  worker answers the few WASI imports with a small shim, and its `abi.json`
  lists them.
- `bindgen`, empty, runs `wasm-bindgen --target web` on the output and ships
  the glue beside the module with every `import.meta.url` in it replaced,
  because the glue must never name its own file.

The rewriter uses neither: its boundary is byte buffers under single-letter
names (`rust/rwjs/src/lib.rs`, `src/wasm/module.ts`), which a host can
rename and substitute at the same length.

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
module: it is handed the bytes and compiles them (`src/wasm/thread.ts`). `BufferInstance` speaks the buffer ABI: strings in and out,
one `configure` per change, a routing import the host answers.
