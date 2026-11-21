# tor-js: the release plus patches

Tor mode's client (docs/tor-over-wisp.md) is arti compiled to wasm by
[tor-js](https://github.com/ethereum/tor-js). The npm release (0.4.4, in
package.json) gives only `fetch`. This directory builds the same release
from source with `patches/` on top, which adds a stream API, so Tor mode can
run epoxy on Tor streams (its own TLS, HTTP/2, kept connections and
WebSockets) instead of tor-js's one-request-per-stream fetch.

Nothing is forked. `upstream.env` pins the release commit and the tools its
own build pins (`rust-toolchain.toml`, `scripts/build.sh` at that commit).
`patches/` holds `git diff` output applied on top of it. `build.sh` does the
rest in a container (docker or podman).

| Patch  | What it does                                                                                                                                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001` | `TorClient.connect(host, port, { isolationKey })`: a TCP stream through Tor (the exit resolves `host`) on the circuits of the key's isolation group (the same groups as fetch's `anonOptions.isolationKey`), as `{ readable, writable }` web streams of `Uint8Array` chunks, each write flushed to the circuit. The destination is not logged. |

## Build

```sh
deploy/tor-js/build.sh             # the release plus patches/: out/dist
PATCHES=0 deploy/tor-js/build.sh   # the release alone: out-upstream/dist
```

The first build takes 15 to 60 minutes, depending on the machine's load. It
prints the wasm's sha256 (`out/SHA256`). `out/PATCHED` lists what the
patches changed. `PATCHES=0` checks the unmodified release's wasm against
the hash tor-js's own CI printed for it (`UPSTREAM_WASM_SHA256`, run
43154142421). That is the provenance check: the npm wasm is the release's
source built with its pinned tools. On 2026-11-21 it reproduced
`071ffb356bdacbf37da1a5549f653ed23f6919a2a856335d082affabfc08fb3d`.

With the patches, the build commits them on the release commit with a
fixed author and date (`out/COMMIT`): tor-js's `build.rs` embeds the
commit, and a timestamp when the tree is dirty, so an uncommitted patch
built a different wasm each time. Committed, two builds from clean give the
same wasm, `PATCHED_WASM_SHA256` in `upstream.env`
(`2e435140e9d3ac8b7ddf3304fc1fdb379b7c2c15b0b77b207381a1a1b6981136`), and
`build.sh` says whether a build matches it.

## How the demo serves it

package.json pins the published build, `"tor-js":
"github:Fracital/tor-js#<commit>"` ("Publish and pin"), and
`demo/server.js` serves that package (`node_modules/tor-js`) at
`/tor-client/tor-js/`, so a deploy needs no container. A tor-js without
`TorClient.connect` (the npm release) fails Tor mode with a clear error
(`demo/public/tor-client/service.mjs`). To try a local build, copy
`out/dist` over `node_modules/tor-js/dist`.

## Publish and pin

```sh
deploy/tor-js/publish.sh          # out/ to Fracital/tor-js, branch dist
PUSH=0 deploy/tor-js/publish.sh   # the commit in a clone under /tmp, not pushed
```

It refuses an `out/` whose wasm is not `PATCHED_WASM_SHA256`. The branch
holds an installable package named `tor-js` (tor-js's manifest with version
`0.4.4-fracital.1`, no scripts, `files` limited to `dist/`, the licences,
`README.md` and `UPSTREAM`), and beside it `build/` (this directory's
Dockerfile, build.sh, upstream.env, README and patches), so its README can
say how to reproduce both hashes without this repository. It prints the
commit to pin: `"tor-js": "github:Fracital/tor-js#<commit>"` in
package.json, as EpoxyTransport is pinned. Its `dist/` keeps only the
`wasm-file` entry, which takes `dist/tor_js_bg.wasm` from our own server
(or whatever `setWasmUrl` names), and its types: the release's other
entries (`wasm-base64`, `wasm-cdn`, the singletons, `anon-rpc-worker.js`)
and every source map are left out, which takes the package from 41 MB to
about 5 MB, and every export, the default one too, is `wasm-file`, so
nothing resolves to the CDN loader.

## Changing a patch

Clone tor-js at `TOR_JS_REV`, apply the patches, edit, and write the diff
back (`git diff > patches/0001-....patch`). To type-check a change against
a built image without a full build, pipe the patch in:

```sh
docker run -i --rm tor-js-fracital:<tag> bash -c 'cat > /tmp/p.patch &&
  cd /src && git checkout -q . && git apply /tmp/p.patch &&
  cd crates/tor-js-wasm && cargo check --release --target wasm32-unknown-unknown --offline' < patches/0001-....patch
```

The image tag covers the Dockerfile and the patches, so a changed patch
rebuilds from the `COPY patches` layer on: the crates are not fetched again.
A changed patch changes the wasm: build it twice from clean (the second in
the built image, `cargo clean` and `bash scripts/build.sh --release`) and
set `PATCHED_WASM_SHA256` to the hash both give.
