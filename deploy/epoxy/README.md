# epoxy-transport: upstream plus patches

The demo (and Fracital) install `@mercuryworkshop/epoxy-transport` from a
build made here, not from npm. The published package resets any HTTP/2
response whose header block is larger than 16 KiB (hyper's default) with
`PROTOCOL_ERROR`; YouTube sends 12 to 20 KB, so it failed through epoxy.
Chrome allows 256 KiB. The build also fixes two hangs: requests started in
one tick on a cold transport (all but one never answered) and a request
handed a keep-alive connection the server had already closed (see the
`epoxy-concurrency` suite). And it reads an HTTP/1 response with a malformed
header line the way Chrome does, where hyper refused the whole response (see
the `malformed-headers` suite). And its WebSocket handshake goes out as
Chrome's does: origin-form, with the port in Host, one User-Agent, Chrome's
fields in Chrome's order, ALPN `http/1.1`, and the server's subprotocol
reported (see the `ws-handshake` suite); TikTok's socket answered 400 to the
absolute-form request line before. The build also carries stomp-h3, HTTP/3
over wisp UDP for stomp's `http3` option (`h3/`, below).

Nothing is forked in the sense of a diverging tree. `upstream.env` pins the
four upstream revisions, `patches/` holds `git format-patch` output applied
on top of them, and `build.sh` does the rest in a container. Bumping upstream
means changing a revision and rebuilding; a patch that no longer applies
fails the build at `git apply --check`.

| Repo                                                           | Patch  | What it does                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r58Playz/hyper-util-wasm (hyper-util for wasm, used by epoxy)  | `0001` | Exposes `http2_max_header_list_size` on the legacy client builder, forwarding to hyper's HTTP/2 builder.                                                                                                                                                                                                                                                          |
| MercuryWorkshop/epoxy-tls                                      | `0001` | Sets that limit to 256 KiB in the client.                                                                                                                                                                                                                                                                                                                         |
| MercuryWorkshop/epoxy-tls                                      | `0002` | `[patch]` in the workspace `Cargo.toml` so hyper-util-wasm comes from the sibling checkout.                                                                                                                                                                                                                                                                       |
| MercuryWorkshop/epoxy-tls                                      | `0003` | wisp: a stream's `poll_close` polls the actor's flume sink after `start_send` (which only queues the close event) instead of returning `Pending`, so the close is sent and finishes. Before, hyper's shutdown of a connection the server closed while idle never completed, its pool kept the dead connection and the next request on it hung.                    |
| hyperium/hyper (v1.6.0, the version epoxy-tls's lock resolves) | `0001` | The HTTP/1 client rewrites a lone CR in a response head before httparse sees it (httparse refuses it even with `ignore_invalid_headers_in_responses`): inside a line it ends the line, at the start of one it moves before the previous LF, before another CR it is trailing whitespace. Chrome splits header lines on CR. NUL is left fatal, as it is in Chrome. |
| MercuryWorkshop/epoxy-tls                                      | `0004` | `[patch.crates-io]` so hyper comes from the sibling checkout.                                                                                                                                                                                                                                                                                                     |
| MercuryWorkshop/epoxy-tls                                      | `0005` | Turns on `http1_ignore_invalid_headers_in_responses` (skip a line with no colon or a control character), `http1_allow_spaces_after_header_name_in_responses` and `http1_allow_obsolete_multiline_headers_in_responses`, which Chrome all reads.                                                                                                                   |
| MercuryWorkshop/epoxy-tls                                      | `0006` | Response header values reach JS as byte strings (one code unit per byte) instead of through `HeaderValue::to_str`, whose `?` failed the whole response over one byte past 0x7E.                                                                                                                                                                                   |
| MercuryWorkshop/epoxy-tls                                      | `0007` | WebSocket handshake: the request-target is origin-form (`GET /path?query`) instead of the whole `wss://host/path` URL hyper's connection-level client wrote. Akamai, in front of TikTok's `im-ws.tiktok.com`, answered that with 400 "Invalid URL" to every handshake.                                                                                            |
| MercuryWorkshop/epoxy-tls                                      | `0008` | WebSocket handshake: `Host` names the port when it is not the scheme's default (`ws://h:38155/` sent `Host: h`).                                                                                                                                                                                                                                                  |
| MercuryWorkshop/epoxy-tls                                      | `0009` | WebSocket handshake: one User-Agent (the caller's replaces the client's; both went out), the caller cannot set Host, Connection, Upgrade, the key, the version or an extension epoxy cannot decode, Chrome's `Pragma`/`Cache-Control: no-cache` and `Accept-Encoding: gzip, deflate, br, zstd`, protocols joined with `, `, and the fields in Chrome's order.     |
| MercuryWorkshop/epoxy-tls                                      | `0010` | A wss connection's ClientHello offers ALPN `http/1.1`, as Chrome's does for a WebSocket; it offered no ALPN at all.                                                                                                                                                                                                                                               |
| MercuryWorkshop/epoxy-tls                                      | `0011` | WebSocket `onopen` gets the subprotocol the server chose (a page's `WebSocket.protocol` was always `""`), and a protocol the client did not offer fails the connection, as in a browser.                                                                                                                                                                          |
| MercuryWorkshop/EpoxyTransport                                 | `0001` | Builds against the sibling epoxy-tls (`file:`), makes it a devDependency (it is bundled), pins TypeScript 5 for the type bundler, version `3.0.2-fracital.1`, stops ignoring `dist/`.                                                                                                                                                                             |
| MercuryWorkshop/EpoxyTransport                                 | `0002` | `init()` loads the wasm module once per realm and builds one client per transport, however many calls overlap. Two concurrent inits instantiated the module twice and the client built on the replaced instance never answered.                                                                                                                                   |
| MercuryWorkshop/EpoxyTransport                                 | `0003` | `connect` passes that subprotocol on to `onopen` (it reported `""`).                                                                                                                                                                                                                                                                                              |

## stomp-h3 (`h3/`)

Our own crate, not an upstream patch: QUIC (quinn) and HTTP/3 (h3) for the
browser, over a datagram channel stomp hands in (epoxy's `connect_udp`, a
wisp UDP stream). It touches nothing in epoxy-tls or EpoxyTransport; the
Dockerfile builds it after them (`h3/build.sh`) into
`out/epoxy-transport/dist/h3/` (`stomp_h3.js`, `stomp_h3_bg.wasm`,
`stomp_h3.d.ts`), so it ships on the same `dist` branch and the demo serves
it as `/epoxy/h3/`. Stomp's `Http3Transport` imports it only when `http3` is
on and an origin offers h3 (docs/http3.md).

- `Cargo.lock` is committed and the build is `--locked`; `wasm-bindgen` is
  pinned to `=0.2.100`, the CLI the image installs.
- `vendor.sh` fetches the crates it patches (h3 0.0.8), checks the crates.io
  checksum and applies `h3/patches/<crate>/*.patch` in order; `Cargo.toml`'s
  `[patch.crates-io]` points at `vendor/`. `h3/0001` writes request
  pseudo-headers in Chrome's order (`:method`, `:authority`, `:scheme`,
  `:path`).
- `out/UPSTREAM` ends with a `stomp-h3 <hash>` line naming the sources that
  went in.

To work on it without the whole image, run `h3/build.sh <out dir>` in a
container of the image `build.sh` tagged (it has the toolchain), copying the
crate in with `docker cp` (docker's filesystem here is not this machine's, so
bind mounts come up empty).

## Build

```sh
deploy/epoxy/build.sh          # docker or podman; 10 to 20 minutes
```

The container installs the Rust nightly, wasm32 target, `wasm-bindgen 0.2.100`
(epoxy's build script checks the exact version), binaryen and Node, clones the
four repos at the pinned revisions, applies the patches in numeric order and
runs epoxy-tls's `publish.sh` (full and minimal, `RELEASE=1`) followed by
EpoxyTransport's `npm run build`, then builds stomp-h3 into its `dist/h3/`.
Where docker's bridge network cannot reach the Rust and npm mirrors, set
`ENGINE` to a wrapper that adds `--network host` to `docker build`. Output:
`out/epoxy-tls` (the npm package layout) and `out/epoxy-transport` (with
`dist/`, `dist/h3/` included), plus `out/UPSTREAM` naming the revisions and
patches that went in.

## Test a build before publishing

The demo serves whatever `@mercuryworkshop/epoxy-transport` resolves to as
`/epoxy/`, so a checkout runs the suites against a build when that package
is the build's `out/epoxy-transport`. In a worktree whose `node_modules`
links into the main checkout's, make `node_modules` a real directory of
links and point only that package at the build, so the shared tree keeps its
pinned copy; then `npm test` as usual (`ws-handshake`, `epoxy-concurrency`,
`malformed-headers` exercise the patches).

## Publish and pin

```sh
deploy/epoxy/publish.sh        # pushes out/ to the dist branches, prints the sha
```

`Fracital/epoxy-tls` and `Fracital/EpoxyTransport` on GitHub hold only
distribution branches named `dist` with the built packages, so consumers run a
plain `npm ci` with no Rust toolchain. Pin the printed commit in
`package.json`:

```json
"@mercuryworkshop/epoxy-transport": "git+https://github.com/Fracital/EpoxyTransport.git#<sha>"
```

Use the `git+https://` form with a full commit sha. npm still writes
`git+ssh` into the lockfile for GitHub hosts and falls back to https when no
key is available, which is how CI and terp install it.

## Changing a patch

Clone the upstream at the pinned revision, `git am` the existing patches,
commit the change, then `git format-patch --no-cover-letter --no-signature
<rev>..HEAD -o patches/<repo>/` and rebuild. Keep one logical change per
patch and the subject line as the summary.
