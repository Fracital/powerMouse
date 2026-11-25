# Tor over Wisp: a Tor client in the browser

Status: the client is Tor mode ("Prototype" below has what it does and does
not do yet). Before it, Tor mode (docs/tor.md) was server-side Tor egress
only: the demo's server ran a Wisp relay (`/wisp-tor/`, `demo/torWisp.js`)
that handed each TCP stream to a tor daemon's SOCKS port. That relay saw
every destination host and port of every visitor, and it could tell
visitors' streams apart only by connection; it is removed ("The old relay"
below). This page is the design that replaced it: **the browser builds the Tor
circuits itself, and Wisp carries nothing but TCP to Tor relays.**

What the operator (the demo's server, the Wisp relay, anyone on that path)
sees in the new design:

- the visitor's IP address, that the visitor uses Tor, and the guard relays
  (and, while bootstrapping, the fallback directories) the visitor's client
  connects to, with timing and volume; where it serves a directory
  snapshot, that a client with no directory fetched it ("The
  fast-bootstrap snapshot"), which the link to a fallback told it before;
- nothing else: the Wisp stream carries Tor's link TLS to the guard's ORPort,
  inside it cells encrypted to each hop, and inside those the site's own TLS.
  Destinations, DNS names, content and which site a circuit is for are
  inside the circuit.

That is the position of a Tor user's ISP. It is not Tor Browser (the browser
fingerprint is the visitor's own browser, the host page is not proxied: see
docs/tor.md "What it is, and what it is not").

## How STomp's transports work today

- **Descriptors, not instances.** The demo describes its transport
  (`transports.epoxy()` in `demo/public/pm/main.js`: a module URL and its
  constructor's options) and the controller imports and constructs it in the
  transport worker (`src/transport/worker.ts`, through `constructTransport`
  in `src/transport/construct.ts`), off the page's thread. The service worker
  and every proxied document reach it over MessagePorts (`serveTransport`,
  `RemoteTransport`). A transport is a `ProxyTransport` of
  `@mercuryworkshop/proxy-transports`: `request(url, method, body, headers,
signal)` answers a fetch, `connect(url, protocols, ...)` opens a WebSocket.
- **epoxy** (our build, `deploy/epoxy/`) is the default: HTTP/1.1, HTTP/2 and
  the site's TLS (rustls) in wasm, over one Wisp connection (Wisp v2, stream
  credit), a TCP stream per connection to the site. HTTP/3 (stomp-h3 over
  Wisp UDP) and Wisp over the relay's WebTransport session ride on it
  (`src/transport/http3/`, `wispWebTransport.ts`, the carrier host
  SharedWorker). **libcurl** is the alternative, over the same Wisp.
- **holyWisp** (`holywisp` npm, a child process of `demo/server.js`) is the
  Wisp server behind `/wisp/`. It refuses loopback and private destinations
  unless `WISP_ALLOW_LOOPBACK` (the suites), relays UDP unless `WISP_NO_UDP`,
  and resolves hostnames itself (`dnsResultOrder: ipv4first`): today the Wisp
  server is also the DNS resolver of every proxied hostname.
- **The network partition.** The service worker adds `$stomp$network`
  (`src/transport/networkPartition.ts`) to each request: `<top-level site>
same-site|cross-site`, or `opaque`. A transport that declares
  `fieldSupport.partition` gets it (epoxy keeps a pool per partition); any
  other never sees it (`fitHeaders` in `serveTransport.ts`). This is exactly
  the first-party key Tor Browser isolates circuits by.

### Tor mode before the client

- **A profile of its own** (`src/profile.ts`, docs/tor.md "Profiles"): every
  store STomp opens in Tor mode carries `|tor` at the end of its name
  (`storeName`, `profileStoreName`), the service worker scope is
  `/stomp-tor/` (or the dialing Tor directory), and the profile is forgotten
  whole when Tor mode is turned off and when its last tab closes
  (`StompController.forgetProfile('tor')`, main.js `beginTorSession`).
- **Where Tor is.** `demo/public/pm/profile.js` decides the mode (`?tor`,
  `?notor`, the saved `stomp-demo:tor`). main.js takes `STOMP_CONFIG.torWisp`
  (written by the server when it runs a relay, `/wisp-tor/`, or
  `STOMP_TOR_WISP_URL`) as `TOR_WISP`; with none, the Tor toggle is disabled
  and a saved Tor choice is an error ("Tor relay unavailable"), never a direct
  connection. `wispURL()` returns `TOR_WISP` in Tor mode, so epoxy simply
  opens its Wisp connection to the relay.
- **Readiness.** `GET /api/tor` (demo/server.js) says the relay's view of the
  tor daemon (`createTorMonitor`, `demo/torWisp.js`: `off`, `starting`,
  `ready`, ...); main.js `watchTor` polls it for the Tor toggle's tooltip.
- **What Tor mode turns off**: HTTP/3, WebTransport, the site pool, real
  ECH's DoH lookup (`ECH_DNS`), since each would leave the Tor route.

## Which Tor client

| Candidate                                                          | What it is                                                                                                                                                                                                                                                                                                                                                                                               | Verdict                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **arti via tor-js** (`tor-js` 0.4.4, npm, MIT OR Apache-2.0)       | The Tor Project's Rust client (`arti-client` with `tor-guardmgr`, `tor-circmgr`, `tor-dirmgr`, `tor-hsclient`) compiled to wasm by the Ethereum Foundation's privacy team, with the wasm changes going upstream (arti MR 3816 makes `arti-client` build for `wasm32-unknown-unknown`). Reproducible build. Takes a **custom socket provider** (`connect("ip:port")` returning a pair of WHATWG streams). | **Chosen**                                    |
| arti upstream, built ourselves                                     | The same code without the wrapper. Builds for wasm with `--no-default-features` since spring 2026, but upstream has no wasm runtime, storage or CI and no JS API.                                                                                                                                                                                                                                        | Where tor-js is going; build from it later    |
| webtor-rs (ethereum/webtor-rs, v0.5.x)                             | Arti's `tor-proto` (1.8) with its own circuit and relay selection and Snowflake/WebTunnel only. Per-domain circuits by the PSL.                                                                                                                                                                                                                                                                          | Superseded by tor-js (same team)              |
| echalote (`@hazae41/echalote` 0.4.18, last published 2024-09, MIT) | A TypeScript Tor client with its own TLS (Cadenas, one TLS 1.2 suite). Its README calls both its Tor protocol and its TLS "unsafe" and "has security issues"; path selection is the caller's (`Math.random()` over flags in its example), no guard manager, no stream isolation.                                                                                                                         | Rejected                                      |
| Brave's Tor (`~/src/brave-core`)                                   | The tor daemon as a child process, the browser a SOCKS client.                                                                                                                                                                                                                                                                                                                                           | Not usable in a page; its UX is the reference |

Why arti via tor-js:

- **Security.** It is arti, not a reimplementation: arti's guard manager
  (guard sampling, primary guards, persistence through its state manager),
  its path selection (bandwidth weights, family and /16 exclusion, exit
  policies), its directory manager (consensus signatures against the
  directory authorities' certificates, microdescriptor digests), its circuit
  manager's stream isolation (`IsolationToken` and keys), congestion control
  and Counter Galois Onion. tor-js exposes isolation as `isolationKey` per
  request. It is labelled experimental, and this wasm build (its runtime,
  storage and socket glue) has had no audit. Its crypto provider for rustls is `rustls-rustcrypto`
  0.0.2-alpha (pure Rust, less reviewed than ring or aws-lc). See "Risks".
- **Feasibility in a worker.** It runs in a dedicated worker (no DOM; it
  checks `window` only to insist on a gateway, which our provider replaces),
  persists to IndexedDB (or any `TorStorage`), and its only network call is
  the provider's `connect`: Wisp TCP fits it without a patch.
- **Size.** `tor_js_bg.wasm` is 5.1 MB (1.9 MB gzip), the wrapper 139 KB;
  epoxy's wasm is 2.2 MB for comparison. Loaded only in Tor mode.
- **Licence.** MIT OR Apache-2.0, as arti; compatible with STomp's.

What tor-js lacks, and what the full design needs from it (a small Rust
change in its `crates/tor-js`, "Remaining work"):

1. **A stream API**: `connect(host, port, isolationKey)` returning a Tor
   `DataStream` as a pair of byte streams, beside its `fetch`. With it, epoxy
   runs on top (site TLS, HTTP/2, the request semantics STomp's transports
   already get right). Done: deploy/tor-js's patch `0001`.
2. **Bootstrap events**: arti's `bootstrap_events()` (percent and blocker),
   for a Tor Browser style progress bar. The prototype reads its log lines.
3. **New identity**: drop the circuits of a key (arti's
   `isolated_client()` / `retire_all_circs`), for "New circuit for this site".

### Provenance of the wasm we serve

What `node_modules/tor-js` is, and how it was checked (2026-11-21):

- **What we serve**: the Fracital build, `github:Fracital/tor-js#aca4f6df96b617464af61f9a243c6de48722c7f9`
  in package.json (deploy/tor-js/publish.sh's dist branch): the release
  below plus deploy/tor-js's patch, its wasm
  `2e435140e9d3ac8b7ddf3304fc1fdb379b7c2c15b0b77b207381a1a1b6981136`,
  which two clean builds give ("Built here too"). Its README and `build/`
  say how to reproduce it without this repository. The rest of this
  section is about the release it starts from.
- **The release**: `tor-js@0.4.4` from the npm registry, pinned exactly in
  `package.json`, `package-lock.json` integrity
  `sha512-0biVOvwZrar+kt+y4GIW4haGYITgspZs1Sv/iJriUIDq3Hs0mM/nkwyO5Ygk+oGjqf7gVuBQhV0uF0RMmTb1UA==`,
  the same as the tarball's own hash computed here. `npm ci --ignore-scripts`
  in a fresh clone installs it from the lock as written, and `npm run check`
  and `node build.js` pass there. The package has no install scripts and no
  dependencies (one optional peer, `@kpstreams/quic-client`, for Node, not
  installed). It has no npm provenance attestation.
- **The wasm**: `dist/tor_js_bg.wasm`, sha256
  `071ffb356bdacbf37da1a5549f653ed23f6919a2a856335d082affabfc08fb3d`. tor-js
  builds reproducibly (pinned rustc 1.97.1, binaryen 116, wasm-pack) and its
  CI prints the hash of what it built. Its CI runs on the release commit
  `d9d9612d10d3775ff100b70e96a291718191d856` ("Release 0.4.4", the
  package's `gitHead`) build it from source on GitHub's runners, and the log
  of run
  [43154142421](https://github.com/ethereum/tor-js/actions/runs/43154142421)
  (2026-11-12) says `WASM SHA256:
071ffb356bdacbf37da1a5549f653ed23f6919a2a856335d082affabfc08fb3d`: **the binary on npm is the one the
  release's source builds**, by a machine other than the publisher's. Its CDN
  entry (`dist/entryPoints/wasm-cdn/index.js`) carries the same hash for
  the binary it loads. We serve the `wasm-file` entry, which loads the binary
  from our own server, never from a CDN; our build's package keeps only that
  entry (deploy/tor-js/publish.sh), so nothing can import the CDN one.
- **The fallback directories** the worker admits before a consensus
  (`demo/public/tor-client/fallbacks.js`) are generated from the crate the
  release was built with: tor-dircommon 0.47.0, crate sha256
  `c16065e5166e529492d1be856e1e40316e2532053027c6b7ab5a4a53c14d8c51`, which
  is the checksum in tor-js's `Cargo.lock` at the release commit
  (`scripts/tor-fallbacks.mjs` says how to regenerate it).
- **Built here too**: `PATCHES=0 deploy/tor-js/build.sh` builds the
  release commit from source in a container with its pinned tools and gets
  the same `071ffb35...` (2026-11-21): the npm wasm is what the release's
  source builds, on two machines. `deploy/tor-js/build.sh` with the patches
  (the stream API, "Epoxy on Tor streams") builds
  `2e435140e9d3ac8b7ddf3304fc1fdb379b7c2c15b0b77b207381a1a1b6981136`, the
  same twice from clean (`PATCHED_WASM_SHA256` in `upstream.env`); the
  patches are committed in the build with a fixed author and date, since
  tor-js's `build.rs` embeds the commit, and a timestamp for a dirty tree.

Updating tor-js means the same checks again: the integrity in the lock, the
release commit's CI hash against the new binary, the fallback list.

## Bootstrap

1. The transport worker loads the client and opens its storage:
   **the Tor client's state** (guards, the directory cache) under a store of
   its own (below, "Guard persistence").
2. With no usable consensus, a client whose server serves a directory
   snapshot loads it from the app's origin, and arti takes the directory from
   it as from its own cache, checked as a download is ("The fast-bootstrap
   snapshot"). With no snapshot, or one the client or arti refuses, arti
   connects to one of its built-in fallback
   directories (a list of relays compiled in, `tor-dircommon/src/fallback.rs`)
   **over Wisp TCP to the fallback's ORPort**, does the link handshake (TLS,
   VERSIONS, CERTS against the fallback's identity), opens a one-hop
   `BEGIN_DIR` stream and fetches the microdescriptor consensus, the
   authorities' certificates and the microdescriptors. All of it is Tor link
   traffic; the Wisp server sees a TCP connection to a fallback's address.
   No DirPort (plain HTTP) is ever used, so nothing about the download is
   readable on the way.
3. With a cached consensus that is still live, it fetches only what changed
   and the microdescriptors it misses, then builds a preemptive circuit.
4. `ready()` resolves when a guard is connected and enough microdescriptors
   are in (arti's "usable" netdir).

### Bootstrap from the kept state

Where the time goes, measured on 2026-11-25 from this machine (Chrome,
the demo on localhost with its own holyWisp, the real Tor network; the
client's own timeline, `[tor]` log lines and IndexedDB reads timed in the
SharedWorker). "Ready" is the host page's Ready, which waits for the
client; the first page is check.torproject.org's answer, submitted at Ready.

| From the host page's load              | Cold (empty store)      | Later visit, before | Later visit, after |
| -------------------------------------- | ----------------------- | ------------------- | ------------------ |
| the client starts (page, SharedWorker) | 0.16 to 0.20 s          | 0.15 to 0.18 s      | 0.14 to 0.15 s     |
| wasm fetch, compile and instantiate    | 19 to 25 ms             | 16 to 28 ms         | 19 to 21 ms        |
| relay check's read of the consensus    | none                    | 152 to 176 ms       | none (37 to 43 ms) |
| tor-js's reads of the store            | 3 ms                    | 206 to 267 ms       | 142 to 150 ms      |
| directory                              | 0.9 to 2.2 s (download) | 0.39 to 0.42 s      | 0.38 to 0.39 s     |
| directory complete to ready (guard)    | 0.10 to 0.17 s          | 0.46 to 0.49 s      | 0.49 to 0.50 s     |
| bootstrap (`bootstrapMs`)              | 1.0 to 2.4 s            | 1.25 to 1.39 s      | 1.04 to 1.06 s     |
| Ready                                  | 1.2 to 2.6 s            | 1.43 to 1.58 s      | 1.20 to 1.22 s     |
| first page                             | 3.1 to 4.1 s            | 2.98 to 4.05 s      | 3.33 to 3.51 s     |

Cold is four runs (one after the change, which leaves it as it was), the
later visit before three and after two. A reload while the SharedWorker
lives (`extendedLifetime`) bootstraps nothing: Ready in 0.12 s, the page in
1.0 s. The cold directory is the download through a fallback: the
consensus 0.38 to 0.64 s, the 7 certificates 0.1 to 0.22 s, 9,562
microdescriptors 0.3 to 1.3 s, depending on the fallback. From Ready the
first page takes 1.5 to 2.5 s in every case: a circuit for the site (0.7
to 1 s) and the site's TLS and answer over it, which no kept state
shortens, and whose spread hides the later visit's gain in the last row.
The wasm (5 MB) costs little here: V8 compiles it lazily, and its download
from a remote server is a first visit's only (the HTTP cache revalidates
it after).

The kept state is tor-js's `TorStorage` (IndexedDB `stomp-tor-client`,
"Guard persistence"), read back at each start: the 7 certificates, about
9,500 microdescriptors (5 MB), the consensus (3.5 MB) and arti's state
(the guards, the circuit timeouts). What made a later visit slower than it
needs (before):

- tor-js's IndexedDBStorage answers `getAll(prefix)` and `keys(prefix)` by
  reading every key and value of the store and keeping the prefix's: a
  start asked `getAll('state:')` (2 values) and `getAll('dir:')`, and paid
  the whole store twice (115 ms each). The service gives tor-js its store
  through `rangedStorage` (`demo/public/tor-client/keptState.mjs`), which
  reads a prefix by a key range (`state:` in 1 to 2 ms).
- The relay check (`admit`, "Which relays the worker may reach") read the
  kept consensus (the whole store again, 116 ms) and parsed it (55 ms)
  before the client was made, and parsed it again at each of the two times
  a start keeps it (30 to 55 ms each). It now takes the consensus arti
  reads back or keeps (`liveDirectory`'s `consensus` listener) and parses
  the newest once, at the first link that is not a fallback; a link it does
  not know of still reads the store before it is refused, so it fails
  closed as before.
- The Wisp WebSocket opens when the client starts, not at arti's first
  link (`WispConnection.warm`): on localhost that is nothing, to a remote
  Wisp server it is the WebSocket's handshake and TLS.

**Only a live consensus is used.** `liveDirectory` hands arti a kept
consensus only until its valid-until (tor-js keeps it as a record that
starts with `valid_after_secs`, `fresh_until_secs` and `valid_until_secs`).
arti reads a cached consensus's times from the signed document itself
(a record with past times but a live document was loaded as live), and its
tolerance for clocks that are off (arti's `DirTolerance`) can take one
after its valid-until, with relays the network may have dropped. Past
valid-until the consensus is not returned and is deleted: the client
downloads a new one and keeps the rest, which is checked anew (a
microdescriptor against the new consensus's digests, a certificate by its
own expiry, the guards by arti's guard rules: guard-spec's sampling,
confirmation and expiry, kept through its state manager). Between
fresh-until and valid-until arti uses the kept one and fetches the next,
as tor does. A record whose times do not read is not used either, and left
in place. A later visit with the consensus expired (simulated by setting
its record's valid-until an hour back) was ready in 3.7 s: one consensus
download (3.3 s from a slow fallback, 0.4 to 0.6 s from the others) and
no certificate or microdescriptor fetched. `node --test
test/tor-kept-state.mjs` checks the rule.

What was left for a first visit was the download itself: the
fast-bootstrap snapshot below makes it one fetch from the app's origin.
Only tor-js could make a later one shorter (it reads the whole directory
into arti at start, 9,500 microdescriptors, where arti needs the ones of
the relays it picks; and arti links to its guard only once the directory is
loaded, though its state names the guard's addresses).

**Progress** follows Tor Browser's bootstrap phases, which arti's
`BootstrapStatus` reports as a fraction and a blocker: "Connecting to a
relay", "Loading directory" (consensus), "Loading relay descriptors" (n of
m microdescriptors), "Building a circuit", "Connected". The transport posts
them to the controller as a transport event and the Tor toggle's tooltip shows the
percentage and the phase, the way `watchTor` shows `/api/tor` today, which in
client mode reads the transport, not the server.

### The fast-bootstrap snapshot

A first visit's client has no directory, and arti downloads one through a
fallback relay: the consensus (0.38 to 0.64 s), the 7 or 8 authority
certificates (0.1 to 0.22 s) and about 9,550 microdescriptors (0.3 to
1.3 s), each a one-hop directory request whose speed is the fallback's.
Where the server serves a directory snapshot, the client loads those
documents in one fetch from the app's own origin and arti takes them from
its cache, as a later visit takes its kept directory.

- **The file**: tor-js's `bootstrap` option (`TorClientOptions.bootstrap`,
  the format tor-js-gateway serves at `/bootstrap.zip.zst`): a zip of
  Stored members `bootstrap/consensus-microdesc.txt`,
  `bootstrap/authority-certs.txt` and `bootstrap/microdescs.txt`, zstd
  optional (tor-js reads the magic). It is about 8.0 MB, 1.43 MB with
  brotli, 1.63 MB with gzip; the server sends it with Content-Encoding, so
  the client hands tor-js the plain zip.
- **Where the server gets it**: `scripts/tor-snapshot.mjs` runs tor-js
  itself in Node, the same arti and wasm as the browser's, with direct TCP
  to the fallback directories' ORPorts (one-hop `BEGIN_DIR`, as the
  browser's client does through Wisp). It waits for arti to mark the
  consensus usable (its record no longer `pending`: the signatures
  checked), takes that consensus, the unexpired certificates and every
  microdescriptor the consensus lists whose text has the listed SHA-256,
  writes `bootstrap.zip`, `.br`, `.gz` and `bootstrap.json` (times, size,
  digest; written last) by rename, and exits. It keeps no state: a run
  downloads the whole directory, about 4 MB, in 4 to 9 s, at about 170 MB
  of memory. No tor daemon on the server, and no parser or signature check
  of our own: fetching from the directory authorities' DirPorts over HTTP
  would need both (or publish what a client then refuses), and would load
  the nine authorities, which dir-spec asks clients to spare.
- **Where it is served**: `GET /tor-client/bootstrap.zip`
  (`demo/torSnapshot.js`) from `STOMP_TOR_BOOTSTRAP`, the directory the
  builder writes. The same bytes for every visitor: no query, the client
  sends no credentials, `Cache-Control: no-cache` with an ETag (a 304 when
  it has not changed), `Vary: Accept-Encoding`. A snapshot past its
  consensus's valid-until, a torn one (the zip is not the size
  bootstrap.json says) or none is a 404. `STOMP_TOR_BOOTSTRAP_EVERY`
  (minutes) has the server run the builder itself at start and on that
  period; without it a timer of the deployer's runs
  `node scripts/tor-snapshot.mjs --out <dir>`. A consensus is published
  every hour and valid for three, so every 30 minutes keeps the file at
  most about an hour behind. `config.js` names it to the page
  (`torClient.bootstrap`, `STOMP_CONFIG.torClient` above) only when
  `STOMP_TOR_BOOTSTRAP` is set, so a host without it runs as before.
- **When the client uses it** (`demo/public/tor-client/snapshot.mjs`,
  `TorService`): tor-js asks for the option only when its store holds no
  consensus (a first visit, or a kept one past its valid-until, which
  `liveDirectory` hides). The option is a thenable that fetches when tor-js
  asks, and sooner when the service's key-range read finds no consensus,
  so the fetch runs beside the wasm's load; a later visit fetches nothing.

**How the snapshot is checked.** The server is trusted with none of it:
tor-js writes the three documents into its storage as arti's cache records
(the consensus marked as checked), and arti's directory manager then loads
them through its normal cache path, the one its kept directory takes
(tor-dirmgr 0.47 at voltrevo/arti `2527494a`, the revision tor-js 0.4.4
builds): `GetConsensusState::add_from_cache` calls the same
`add_consensus_text` a download does (parse, time check, and
`authorities_are_correct` against the authority identities compiled into
arti), `GetCertsState::add_from_cache` checks each certificate's signature
by its authority's identity key and its expiry, and `try_checking_sigs`
checks the consensus's signatures with those certificates before the state
advances. tor-js keys each microdescriptor by the SHA-256 of its text, and
arti reads only the digests the checked consensus lists. Confirmed by
reading that code and by running tor-js's wasm in Node with every link
refused (`test/tor-snapshot.mjs`): a snapshot the builder made loads as
"Loaded a good directory from cache" with no link at all; the same file
with one byte of a relay's nickname changed fails the start ("corrupted
data in cache: Unable to bootstrap a working directory") before any link.

What arti does not refuse, the client does:

- **A stale snapshot.** arti's clock tolerance (`DirTolerance`, three days
  after valid-until) takes an old consensus: with the clock moved 4 hours
  on (the snapshot's consensus 1 to 2 hours past its valid-until), arti
  loaded it from cache and only then asked for a newer one. The client
  checks the consensus's own `valid-until` line before arti sees the bytes
  (`checkSnapshot`, whatever the server's bootstrap.json says) and refuses
  one at or past it, one with no consensus member, a member that is not
  Stored, a consensus that is not a microdesc one, and more than 32 MiB.
  tor-js then downloads the directory, as with no snapshot.
- **A snapshot arti refused, kept.** A consensus whose signatures do not
  verify fails arti's cache load with an error that ends the start (a
  `Reset` error, which `load_directory` returns from bootstrap), and tor-js
  has written it to the store, marked as checked, before arti looked at
  it: kept, it would fail every later start. So from the moment arti has
  the snapshot, every write of a consensus key is held back
  (`holdConsensus`) until arti says "Loaded a good directory from cache",
  then written in order; a start that fails before that drops them, does
  not use a snapshot again, and starts the client once more without one
  (the download). If arti downloads a directory of its own instead (a
  snapshot with certificates it could not use, say), the snapshot's
  consensus is the one write left out. Certificates and microdescriptors
  are not held: arti checks a certificate at every load and keys a
  microdescriptor by its digest. The relay check ("Which relays the worker
  may reach") hears of the snapshot's consensus only when it is written,
  so it admits no relay of a consensus arti has not checked.

It fails closed as the rest does: the snapshot is directory data on the
way to arti's own checks, never a route; anything wrong with it is the
download, and no request goes anywhere but through the client.

Measured on 2026-11-25 from this machine (Chrome 159, the demo on
localhost with its own holyWisp, the real Tor network, a fresh browser
context for each first visit, the two servers in paired rounds, the order
turned each round, load average 11 to 16 on 28 cores):

| First visit               | Download (no snapshot)        | Snapshot                      |
| ------------------------- | ----------------------------- | ----------------------------- |
| bootstrap (`bootstrapMs`) | 0.86 to 4.74 s, median 3.44 s | 1.03 to 1.16 s, median 1.10 s |
| Ready                     | 1.03 to 5.03 s, median 3.61 s | 1.23 to 1.34 s, median 1.29 s |

Seven runs without and six with. A download is as fast as its fallback
(two of seven took under 1.1 s, five 2.0 to 4.7 s); the snapshot takes the
same 1.1 s every time. In Chrome, a snapshot with one byte of its
consensus changed was refused and the client downloaded the directory
(4.0 s), and its store then held only the downloaded consensus; the next
visit started from it in 0.9 s. The protected site (`npm run build:demo-site`,
`STOMP_DEMO_SITE`) serves the same route and its client took the snapshot
(Ready in 5.2 s with the page's load, the client's bootstrap 1.7 s).

Where a snapshot start's 1.1 s goes (the client's timeline): the fetch,
55 ms on localhost, beside the wasm's load; tor-js reading the snapshot
into the store, 0.2 s, 163 ms of it parsing the consensus with arti's
parser only for its times; arti's cache load and its checks, 0.2 s, and
the same load again when its download task starts, 0.12 s; then the link
to a guard, 0.49 s, which arti opens only once the directory is loaded.
What is left is tor-js's and arti's: reading the times from the
consensus's preamble in tor-js's `fast_bootstrap.rs` would save about
0.15 s (a patch and a wasm build), and the guard link could start before
the directory only inside arti. From a remote server the fetch is 1.43 MB
over the visitor's HTTPS connection to the app, which the download through
a fallback also moves, over a Tor link and its flow control.

### Guard persistence

Tor's security against a hostile guard rests on keeping few guards for
months. Tor mode's profile is forgotten when its last tab closes; if the
client's state lived in it, every session would sample new guards, which
over time hands a hostile guard many chances. So, like Tor Browser (whose
New Identity keeps `state` and its guards), **the client's state is not part
of the `tor` profile's site data**: it is one store of its own, kept across
sessions and New Identity, holding only guards and public directory data,
forgotten only by an explicit "Forget Tor state" and by clearing site data
of the host. Its name, IndexedDB `stomp-tor-client` (tor-js's
`IndexedDBStorage`, opened in the client's realm), is of no profile
(`profileOfName` gives the default profile's ''), so forgetting the `tor`
profile leaves it; `test/store-names.mjs` checks it is the client's only
store and that name.

**Forget Tor state** (the menu, in Tor mode with the client) is the only
way to drop it short of the browser's site data: the page asks its
transport on its channel, the transport the shared client
(`TorService.forgetState`), which closes arti's client and its links,
deletes every key of the store (and of the memory tor-js's locking wrapper
keeps when another holds the store's lock), forgets the consensus's relays
and the session's circuits, and starts the client again: it samples new
guards and downloads the directory anew. Every tab of the shared client
hears its status start over and drops its connections. Tor Browser has no
such control (a new profile is its way); here the Wisp server's operator
sees the guard, so a user may want it changed, at the cost Tor's guard
design warns of when it is done often.

What tor-js does and does not give for it:

- The state is tor-js's whole `TorStorage`: arti's state manager writes
  under `state:` keys (its guards are the `guards` value, tor-guardmgr's
  `GuardSets` as JSON: `default.guards` with each guard's `id`, `ed25519`
  and `rsa`, and its `orports`; `default.confirmed` in arti's order), its
  directory under `dir:` keys. The client keeps the store itself, so it can
  read and empty it, but tor-js has no call to forget the guards alone or
  to reset a running client's guard manager: Forget Tor state closes the
  client and makes another, and the guards' JSON is arti's internal
  format, read best-effort (a value that does not read as one is no guard).
- Where a tab runs a client of its own (no SharedWorker: Chrome on
  Android, or the SharedWorker did not answer), Forget Tor state restarts
  only that tab's client; another tab's own client keeps its guards in
  memory and may write them back.

The cost: the operator sees the same guard from the same browser across
sessions, a pseudonym that survives an IP change. A Tor user's ISP sees the
same. A deployer can remove it (and the fact that the visitor uses Tor at
all) with bridges ("Remaining work", WebTunnel).

## Link layer and the Wisp server

- **TLS to the relay is inside the client**: arti's `tor-rtcompat` over
  rustls (rustls 0.23 with `rustls-rustcrypto`), compiled into the same wasm.
  Tor relays present self-signed link certificates; the relay is
  authenticated by the CERTS cell (its Ed25519 and RSA identities against
  the consensus), not by the WebPKI. epoxy's TLS is not used for the link.
- **Wisp carries raw TCP**: the provider opens a Wisp v1 stream (CONNECT,
  TCP, the relay's IP and ORPort as given by the consensus; never a
  hostname, so the Wisp server resolves nothing) per channel, and pipes
  bytes, honouring the server's CONTINUE credit.
- **Should the Wisp server enforce "only Tor relays"?** It adds no
  confidentiality (the client never connects anywhere else: arti dials only
  relays from its signed directory and its compiled-in fallbacks), so the
  client's safety must never depend on it. It is worth having as the
  operator's policy, for a deployer who offers Tor but not an open proxy:
  a Tor-only Wisp endpoint (`/wisp-or/`, `STOMP_CONFIG.torClient.wisp`)
  that accepts TCP CONNECTs only to an `ip:port` that is an ORPort in the
  current consensus or a fallback directory's ORPort, refuses hostnames,
  UDP and everything else (close reason 0x48, blocked). holyWisp has
  `whitelist.hostnames` and `whitelist.ports` (`allow-host`, `allow-port`)
  but no pairing of the two; the endpoint is either holyWisp given the
  list (refreshed with each consensus, about 9000 addresses) or a small Node
  Wisp server in demo/ that checks each pair. tor-js's own gateway does the
  latter ("connections only to addresses in the consensus"). The server
  fetches the consensus itself (it needs it anyway for the fast-bootstrap
  snapshot). The demo's existing `/wisp/` keeps refusing private
  destinations; in Tor mode the client uses `/wisp-or/` when the server
  offers it and `/wisp/` otherwise.
- **What our server learns**: that this visitor uses Tor, their guards and
  their traffic's timing and volume. If the operator also runs or watches
  exits, it is in a better position than an ISP for end-to-end correlation
  of its own visitors: one more reason the visitor should be able to pick a
  bridge, and why Tor mode's UI says that the operator sees Tor use.

### Which relays the worker may reach

The worker checks every link arti asks for before it opens a Wisp stream
(`admit` in `demo/public/tor-client/transport.mjs`): the address must be a
fallback directory's ORPort (`fallbacks.js`, the list compiled into the same
arti) or a relay's ORPort in the newest consensus the client kept (read from
its storage at start, and from each consensus arti writes: the microdesc
flavour's `r` and `a` lines). Anything else is refused before it reaches the
Wisp server, and the transport counts it (`status.refused`) and warns on the
console. arti never asks for anything else; the check is there so that a bug,
or a tampered module, cannot use the Wisp server to reach a site directly,
past Tor. The smoke checks a fallback passes, a site's address is refused, and
no link the client asked for in a real session was refused.

**Is a server-side check worth adding?** Not for the visitor: the client
must never depend on the Wisp server for its safety, and the visitor's
protection is the client's own check above. For the operator it buys little
here, because the same server's `/wisp/` is an open TCP relay for normal
mode anyway; a Tor-only allowlist on the endpoint Tor mode uses would only
matter for a deployer who offers Tor and nothing else (then: `/wisp-or/`
below). Not worth it now; listed in "Remaining work".

## HTTPS, DNS and what Tor mode refuses

The full design (needs the stream API above):

```
proxied page -> service worker -> transport worker
  epoxy (site TLS, HTTP/1.1 and HTTP/2)            <- end to end with the site
    Wisp v2 function transport, served in the worker:
      CONNECT tcp host:port  -> tor client connect(host, port, isolationKey)
      CONNECT udp            -> CLOSE 0x48
  tor client (arti): circuits, cells, link TLS
    Wisp v1 over the WebSocket to /wisp-or/ (or /wisp/): TCP to the guard
```

- epoxy is given a function transport (as the WebTransport carrier already
  gives it, `src/transport/wispWebTransport.ts`) whose Wisp server is a few
  hundred lines in the transport worker: each TCP CONNECT becomes a Tor
  stream (a `BEGIN` cell with the hostname: **the exit resolves it**), each
  DATA packet goes on that stream, credit and CLOSE are mapped both ways.
  epoxy never resolves a name (its `ech_dns` DoH is off in Tor mode, as now).
  The site's TLS is epoxy's, end to end; the exit sees only TLS. `http://`
  sites are readable by the exit, as in Tor Browser (HTTPS-Only is the
  answer there, and the demo can default to it in Tor mode).
- **DNS** is the exit's. Nothing STomp sends in Tor mode asks the browser or
  the server to resolve a proxied name. An explicit lookup (none today) would
  be a `RESOLVE` cell (arti `resolve()`). HTTPS records (and so real ECH) are
  not available through `RESOLVE`; GREASE ECH stays.
- **Refused in Tor mode**: UDP (Tor has none: HTTP/3 off, as now, and the
  virtual Wisp server closes any UDP CONNECT), WebTransport (UDP) and
  WebRTC's UDP candidates. **WebSocket** is TCP, Tor carries it and Tor
  Browser allows it: on Tor streams epoxy carries it as in normal mode.
- **Isolation of the wire format**: the transport takes the
  `$stomp$network` field and never sends it (`fieldSupport.partition`).

Tor mode's `request()` and `connect()` are epoxy's on Tor streams (epoxy's
TLS end to end, DNS at the exit; "Epoxy on Tor streams").

## Per-site circuits and New Identity

Tor Browser isolates circuits by the first-party domain (the URL bar's
eTLD+1); Brave by the top frame's site plus a nonce per site that it renews
after about ten minutes and on "New Tor connection for this site"
(`TorProxyMap`, docs/tor.md "Per-site circuits").

- **Key**: the top-level site from `$stomp$network` (its first word; a
  `cross-site` frame's requests share their top's circuits, as in Tor
  Browser), `opaque` for a context with none. The isolation key is
  `<session nonce> <site nonce> <site>`: requests of different keys never
  share a circuit (arti stream isolation).
- **New circuit for this site**: a new site nonce for that site; its next
  request builds a new circuit (and, with the stream API, epoxy's pool for the
  partition is dropped so no old connection is reused).
- **New Identity**: a new session nonce, every pool dropped, and the `tor`
  profile forgotten (cookies, storage, caches), as Tor mode's "turn off and on"
  does today. Guards and directory data stay, as in Tor Browser.
- **Circuit lifetime**: arti's dirtiness (ten minutes) applies per key.
- **A new Tor session**: the shared client outlives its pages by up to five
  minutes (`extendedLifetime`), so the first page of a new session (the
  profile forgotten, `torSession.fresh` in pm/main.js) passes a token in
  its transport's options (`session`) and the client takes a new session
  nonce for it (`TorService.newSession`), once per token: a site visited
  in both sessions gets a circuit of its own in each.

### Circuit display

Tor Browser's "Circuit for this site" lists the hops (this browser, the
guard, a middle relay, the exit, the site) with each relay's country and
address. The menu's **Tor circuit for this site** (a submenu, in Tor mode
with the client) shows what the client can tell of the active tab's
site's circuits (`TorService.circuitFor(url)`, asked on the page's
channel):

- **The guard**: the first of arti's guards (its guard state's confirmed
  order, "Guard persistence") that a link is open to now, as arti's exit
  circuits all go through its first usable primary guard
  (`guard_use_parallelism` 1); where the state names none, the one relay a
  link is open to; with no link open (idle connections), the guard arti
  tries first, said so. Its nickname and fingerprint come from the
  consensus the client keeps (the `r` line of its ORPort), its address from
  the link.
- **The site**: its circuit key and since when the key's circuits are used
  and how many streams went on them (a New Tor circuit for this site or a
  New Identity starts it again).

What tor-js does not give, and the display says so:

- **The middle and exit relays.** tor-js returns a stream, not its
  circuit: arti's `ClientCirc` and its path (`path_ref()`, each hop's
  identities) never reach JS, and arti logs no relay of a circuit at the
  levels we read (its `safelog` redacts them). A patch to tor-js that
  returned the path with `connect()`, or an `isolationKey`'s circuit on
  request, would let the display name every hop.
- **Countries.** A consensus has no country; arti's `tor-geoip` database
  is not in tor-js's build, nor any call to it. Tor Browser's countries
  come from tor's GeoIP files.
- **Which guard a circuit took.** The display reads the guard from links
  and state, not from the circuit; with more than one primary guard in
  use (a guard that failed, directory fetches over others) it shows the
  first that is linked, which is the exit circuits' guard in arti's
  default configuration.

## The old relay

**Removed** (`demo/torWisp.js`, `/wisp-tor/`, the `STOMP_TOR_*` settings
but `STOMP_TOR_CLIENT`, test/tor-wisp.mjs). A server that sees every
destination of every visitor and links them by connection is the opposite
of what Tor mode promises. A deployer who still sets one of its settings
gets one line at startup saying it is ignored, and Tor mode is the client.
A deployer who wants server-side egress through Tor for their own reasons
can point `STOMP_WISP_URL` at their own Wisp server with a SOCKS upstream:
STomp needs no code for that.

## Risks

- **Not audited**: tor-js is experimental; arti's code is the Tor Project's,
  the wasm runtime, storage and socket glue are tor-js's and unaudited; `rustls-rustcrypto` is
  alpha. Pin by hash (its build is reproducible) and review its changes as we
  review epoxy's (`deploy/epoxy/`).
- **Same realm as nothing hostile**: the client runs in the transport worker,
  which no proxied page can reach (pages talk to it over MessagePorts with a
  fixed protocol). That is better than tor-js's own warning ("a compromised
  dApp could inspect WASM memory"), which is about running it in the page.
- **Timers**: browsers coarsen `performance.now()`; arti's congestion control
  and padding run on it. Chrome gives 100 microseconds without cross-origin
  isolation (5 with it), coarse next to native but well under a round trip.
- **Fingerprint on the wire**: arti's link TLS from rustls differs from little
  tor's OpenSSL ClientHello; a guard (or a watcher of the link) can tell an
  arti client. Arti native has the same property.
- **Two tabs, two clients**: each transport worker would run a client and
  pick circuits apart. One client per origin runs in a SharedWorker
  (`demo/public/tor-client/shared.mjs`, "Prototype"); where none starts
  (Chrome for Android has no SharedWorker) each tab still runs its own.

## Prototype

Tor mode (`STOMP_TOR_CLIENT=0` turns it off, and the Tor toggle with it;
`STOMP_TOR_CLIENT=stand-in`, for the suites, which reach no Tor network,
answers Tor mode with epoxy over `/wisp/`). Tor mode's transport is
`demo/public/tor-client/transport.mjs`, a client of the one Tor client
every tab of the origin shares: its descriptor's `sharedWorker`
(TransportDescriptor.sharedWorker, a library hook: a dedicated worker cannot
start a SharedWorker, so the controller starts it and gives the transport a
port to it) is `demo/public/tor-client/shared.mjs`, which runs the client
(`service.mjs`) and opens every tab's Tor streams over its port, each
stream on a port of its own (`remote.mjs`, `streamPort.mjs`). Where no SharedWorker starts, or it does not answer in 15 s,
the tab runs a client of its own in its transport worker. The controller
starts the SharedWorker with `extendedLifetime: true`
(`src/transport/sharedWorker.ts`, as the carrier host:
docs/webtransport.md), so in Chrome 157 and later it outlives the
origin's last page by up to five minutes: a reload or a navigation gets
the same client back, bootstrapped, its circuits and its link to the
guard open, and a new Tor session's first page says so to it ("Per-site
circuits and New Identity"). Every page asks with the option (Chrome
refuses a page that asks for the same worker without it); a browser that
does not know it (Firefox, Safari) ignores it, and there the client still
ends with the origin's last page. The client is tor-js 0.4.4 with deploy/tor-js's stream API
(`node_modules/tor-js`, served at `/tor-client/tor-js/`), its socket provider a Wisp v1 client of its own over
the demo's ordinary `/wisp/`, its storage IndexedDB `stomp-tor-client` (the
app's origin; not the `tor` profile's, so it survives the
profile), each stream on the circuits of an isolation key per top-level
site (`$stomp$network`) and session nonce, epoxy on top ("Epoxy on Tor
streams").
The transport tells the page its bootstrap on a BroadcastChannel the page
names in the descriptor (Tor Browser's phases: "Connecting to a relay",
"Loading network status", "Loading authority certificates", "Loading relay
descriptors", "Establishing a Tor circuit", "Done", read from arti's log), and
the Tor toggle's tooltip and the status line show it. The menu
(the three dots) has **New Identity** (a new Tor session: the page loads
again with a new transport worker, so no circuit of before, and the `tor`
profile is forgotten; with other Tor tabs open it asks to close them first,
since they share the identity), **New Tor circuit for this site** (a new
isolation nonce for the tab's site, and the tab loads again), **Tor circuit
for this site** ("Circuit display") and **Forget Tor state** ("Guard
persistence"). The channel is
same-origin, so in the isolated mode (the controller in the proxy's frame)
the page hears nothing and the items are not offered; the dialing mode,
which production uses, is same-origin.

`node test/tor-client-smoke.mjs` (after `node build.js`; `SKIP_NETWORK=1`
skips it, and it is not a suite: it needs the public Tor network) starts a
demo server of its own with holyWisp logging every stream, opens the demo
with `?tor=1` in the suites' Chrome (`--host-resolver-rules` resolves no
name but localhost, so nothing but the Wisp connection leaves), loads
`https://check.torproject.org/api/ip`, `https://api.ipify.org/?format=json`
and the first again, keeps the session 90 s, ends the client's
SharedWorker (DevTools' terminate, `Target.closeTarget`: it would outlive
the page), opens a fresh host page (a new transport worker and client)
and loads the first site once more. It checks
that the site says `IsTor: true`, that every Wisp stream went to an IP
address (never a name), and that the fresh client went only to relays the
first one had (its guards were kept).

Measured on 2026-11-21 from this machine (load average 50 to 95 on 32 cores),
five runs, the last four complete:

| What                                                              | Measured                                       |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| Cold bootstrap (consensus, 8 certificates, 9566 microdescriptors) | 2.0 s, 3.7 s, 2.0 s, 2.0 s                     |
| Bootstrap with the directory kept in IndexedDB                    | 1.3 s, 1.1 s, 1.4 s, 1.0 s                     |
| First site, submitted before bootstrap ended                      | 13.1 s (one slow circuit), 1.0 s, 3.6 s, 3.1 s |
| Another site (a circuit of its own)                               | 2.2 s, 1.3 s, 1.6 s, 2.3 s                     |
| The first site again (its circuit reused)                         | 1.4 s, 1.6 s, 1.5 s, 1.2 s                     |
| Wisp streams per session                                          | 3 to 5, all `ip:orport` (443, 445, 9001, 9200) |
| Exits: two sites / one site twice                                 | different in every run / the same in every run |
| `tor_js_bg.wasm`                                                  | 5,083,815 bytes, 1.99 MB gzip                  |
| tor-js's module (`wasm-file` entry) / our transport               | 139 KB (32 KB gzip) / 9 KB                     |

Guards: a fresh client went back to the first one's guards when the first
session had lasted 90 s, and picked new ones when it had lasted under 20 s
(two runs): arti writes its state on its own schedule, so a very short visit
keeps no guards. One earlier run ended with Chrome gone during the first load,
not seen again.

A later run (2026-11-21, the default path: `?tor`, in the
dialing mode production uses) also checked: `/api/tor` and `config.js` say
`client` and the toggle is enabled; the page heard the bootstrap through to
"Done" and the toggle says Tor connected; the worker admits a fallback directory and
refuses a site's address; New Tor circuit for this site loaded the site again
through another exit (171.25.193.39, then 109.70.100.12); and no link arti
asked for in the session was refused. Bootstrap 2.6 s cold, the first site
2.6 s, another 3.1 s, the first again 2.1 s, its new circuit 4.6 s. An earlier
run on the isolated mode had check.torproject.org's circuit stall (no answer
for 240 s, then a 502): a request with no answer's head in 30 s is now tried
once more on a new circuit for its site (GET, HEAD and OPTIONS only).

With the shared client (the same day, the same smoke with a second tab of
the same browser context): the second tab heard the first tab's client
ready in 320 ms, its instance and bootstrap the first's (6.4 s and a
bootstrap of its own before); once both pages were gone, a fresh page's
client started again from the kept state (2.2 s) and went to the first
one's guards.

### Epoxy on Tor streams

deploy/tor-js builds tor-js 0.4.4 from source with one patch,
`TorClient.connect(host, port, { isolationKey })`: a Tor stream as a pair
of web streams, on the key's isolation group (deploy/tor-js/README.md).
`deploy/tor-js/publish.sh` puts the build on Fracital/tor-js's `dist`
branch, package.json pins it, and `demo/server.js` serves it at
`/tor-client/tor-js/`: a deploy needs no container. Tor mode's transport is
epoxy: one epoxy client for
each top-level site (at most 32, the least lately used dropped with its
connections), its function transport a Wisp v1 server in the transport
worker (`wispServer.mjs`) whose every CONNECT is `connect(host, port, site)`
on the shared client, the stream relayed between the SharedWorker and the
tab over a port of its own with a window each way (`streamPort.mjs`). UDP
CONNECTs close with reason 0x48. So connections are kept and pooled per
site, HTTP/2 is negotiated, WebSockets work, and the site's TLS is epoxy's,
Chrome's ClientHello, not tor-js's rustls one. New Tor circuit for this site
drops the site's epoxy client in that tab (its kept connections were on the
old circuit); another tab's keeps its connections until they close. A
stream that does not open in 20 s, or fails, is tried once on a new circuit
for the site. The `tor-streams` suite runs epoxy over the Wisp server and
the port relay with the demo's own `/wisp/` standing in for Tor.

The real-network smoke on this build (2026-11-21, Chrome): check.torproject.org
says `IsTor: true`, one.one.one.one's trace says `http=http/2`, and
echo.websocket.org echoes a WebSocket message from a proxied page.
Bootstrap took 4.0 s and the first site 1.7 s after it; another site took
1.6 s, the first site again 1.6 s and its new circuit 1.6 s (on the
release's own fetch, which the prototype used before, they took 2.1 to
3.1 s, each request a stream and a TLS handshake of its own). Firefox 160 loads check.torproject.org through it too.

What the client does not do yet:

- **No HTTP/3, no WebTransport**: Tor carries no UDP.
- **Progress and the menu items need the same origin**: in the isolated
  mode the page hears nothing from the proxy origin's worker; the status
  says "Tor route selected" and the items are not offered.
- **A reload starts the client again outside Chrome** where it was the
  origin's only page: Firefox and Safari have no `extendedLifetime`, so
  the SharedWorker ends with the page (a warm bootstrap, 1 to 2 s). In
  Chrome it outlives the page by up to five minutes.
- **The ordinary `/wisp/`**: no Tor-only endpoint on the server (the worker's
  own check refuses non-relays, "Which relays the worker may reach").
- Not covered: the sync relay of WebKit's frozen pages (Tor mode's
  `/stomp-tor/sync-relay` refuses, so those pages' synchronous requests
  fail rather than leave Tor). offline.html has Tor mode of its own
  ("Offline, and hosts that name the files").

### Offline, and hosts that name the files

offline.html (demo/README.md "offline.html") carries the client: the
transport bundled into one module the page imports (tor-js inside, for a
client of the page's own where the worker does not answer), the client
bundled into a classic script (`demo/offline/tor-worker.mjs` around
`shared.mjs`) and `tor_js_bg.wasm`, 2.6 MiB of the file's payload. On file:,
Chrome 158 starts no SharedWorker (classic or module) and no module worker
of a blob: URL, and a dedicated worker there fetches none of the page's
blob: URLs, so the page starts one classic worker of its own at the first
Tor transport (`demo/offline/host.mjs` torOptions), compiles the wasm and
posts the module to it, and gives each transport a port to it, as the
served demo's get one to their SharedWorker. Each tab of the file runs a
client of its own. Its IndexedDB is the file:// page's (the worker's is
the same store) and is kept across reloads and browser restarts, so a
second visit bootstraps from the kept directory and guards: 4.1 s cold and
2.0 s warm, the first page 14 s and 2.6 s (Chrome 158, the public holyWisp,
2026-11-21). The file's Wisp server is its own (`wss://holywisp.fracit.al/`
as built), which relays TCP to relays' ORPorts as the demo's `/wisp/`
does. The transport bootstraps the shared client when it is made, not at
the first request (a page-hosted transport is asked nothing until a tab
loads). The offline-html suite builds a file with tor-js replaced by
`test/offline-tor-stand-in.mjs` (`--tor-stand-in`), whose "Tor streams"
are TCP to 127.0.0.1 through the run's wisp server, and `OFFLINE=1 node
test/tor-client-smoke.mjs` runs the smoke on `build/offline.html`.

A host that serves the client's files under names of its own (SystemYA's
static deploy) gives them as `STOMP_CONFIG.torClient`, an object in place of
`true`: `module` (the transport), `sharedWorker` (the SharedWorker's script,
or `false` for none) and `wasm` (arti's binary), each a URL, any left out
at the demo server's `/tor-client/` path. The transport passes `wasm` on to
tor-js (`setWasmUrl`, `useWasm` in service.mjs; the first one given is
kept), so the module and the wasm need not be side by side.

Firefox (160) runs the client too: the Firefox smoke (`npm run
test:firefox`, with the network) opens the demo with `?tor=1` and has
check.torproject.org say `IsTor: true` through it, so the wasm in a
dedicated worker, the client's IndexedDB and the Wisp socket provider work
there as in Chrome (bootstrap 4.0 s cold, the first answer 6.2 s).

### Bootstrap progress and failures

The client's status (`TorService.status`, which the transport tells the page
on its channel) has `blocked: { kind, message }` while something holds
bootstrap up, and a failed bootstrap's `summary` is that reason rather than
arti's error (kept as `error`). Two sources, the first winning:

- **arti's own events**, where tor-js gives them:
  `client.bootstrapEvents(listener)` (returning its removal), each event
  `{ fraction, ready, blocked }` as arti's `bootstrap_events()` yields its
  `BootstrapStatus` (`as_frac()`, `ready_for_traffic()`, `blocked()`), with
  `blocked` null or `{ kind, message }`, `kind` one of arti's
  `BlockageKind`s (`offline`, `filtering`, `cant-reach-tor`,
  `clock-skewed`, `cant-bootstrap`). Its progress replaces what the log
  says. **tor-js has no such call yet**: it needs a patch in deploy/tor-js
  and a wasm build, neither done yet (deploy/tor-js builds in a container). The
  service uses it once it is there; the suites' stand-in implements it.
- **The client's own links**, today: the Wisp server cannot be reached
  (`offline`, "Cannot reach the Wisp server"), it closes links to relays
  with "blocked by policy" (`filtering`), or two links or more ended before
  a byte with none reached (`cant-reach-tor`, "No Tor relay answered
  through the Wisp server (N links ended with a refused connection)"). A
  link that is reached clears it.

The toggle's tooltip, the status line and error.html show the reason
("Tor is connecting (50%): Loading relay descriptors. Blocked: ...", "Tor
could not connect: ..."). A refused link (the relay check below) is told
to the page too (`refused`).

### It fails closed

A Tor-mode page has no transport but the Tor client's (`transportFor` gives
`torClient` whatever is chosen, HTTP/3, WebTransport and ECH DNS are off, a
deployment without the client refuses Tor mode), and the client's
transport has no raw client for a page's WebTransport or WebRTC streams.
So every failure of the client is a failed request, never a direct one:
while it bootstraps a request waits for it, a failed bootstrap fails the
request and the next one starts the client again, a circuit that does not
build fails its stream, and a link arti asks for to anything but a relay
is refused ("Which relays the worker may reach"). A browser tab in Tor
mode stays in it across its reloads even when another tab turned Tor off
since (the saved choice is the origin's: pm/profile.js), so a reload
cannot bring it back up outside Tor.

The `demo-tor-fail-closed` suite checks it with Tor mode's own client code
and tor-js replaced by a stand-in it breaks on purpose
(`STOMP_TOR_CLIENT=stand-in-arti`, test/offline-tor-stand-in.mjs, whose
"Tor streams" reach the fixture through the run's Wisp server): bootstrap
that never ends (one tab, a second tab of the same client, a reload),
every link failing at the Wisp server, circuits that do not build (two
tabs), and a client that dials the site itself. In each, the fixture page
asked for records no request. It also checks the reasons shown, the retry
after a failure, a Tor tab kept in Tor mode when another turns it off, and
a Tor tab's site data across its reload. And the client's life and state:
the same client, bootstrapped, after a reload and a navigation
(`extendedLifetime`), a new Tor session on it with none of the last one's
circuits, the circuit display's guard (the stand-in keeps a guard state and
a consensus as arti does), and Forget Tor state emptying the store and
starting the client again. It reaches no Tor network.

Nor does the host's server read a site's address from a route. Some
proxied requests reach it at their route,
`/stomp-tor/<id>/<kind>/<sealed URL>`: a forced reload of a page at the
top of a tab of its own and that tab's favicon request (whose Referer is the route) go past the service
worker; a page whose tab is gone found no controller once the worker had
started again, and after the revive window the worker handed its
requests (posts and beacons with bodies, images) to the network, as it did
with a navigation to the route; and a dialed page's about:blank frame
resolved its URLs against the call page, so its images went to the host
as raw relative paths. The xor codec's routes are no protection there:
its stream is the same for every URL under a key, so a server that knows
the URL of one page opens the others. Tor mode's routes are sealed with
the siv codec instead (docs/codec.md, deterministic authenticated
encryption under a key the worker draws, which nothing sent to the host
carries), its worker answers every request at its routes itself (an
error, or a "Not available" page for a navigation) where it would have
passed it on (`sealedFromHost`, src/server/serviceWorker.ts), and an
about:blank document of a dialed page takes its creator's base. The demo's
server answers a Tor route with a fixed 404 and logs nothing of it. What
the server still sees of a route is its length (to 16 bytes) and that a
URL was asked again. The `demo-tor-routes` suite records every request
the server gets in Tor mode and finds the site in none, in any reading of
it (tor.md, "Tested").

## Remaining work

The client is Tor mode. What it still needs
to be as good as Tor Browser's, with rough sizes (S under a day, M a few
days, L a week or more).

1. **Stream API in tor-js** (done; S left): `connect(host, port,
isolationKey)` (deploy/tor-js `0001`); left: `resolve()`,
   `bootstrapEvents()` (arti's `bootstrap_events()`: the JS side and its
   shape are done, "Bootstrap progress and failures"; the patch and its
   wasm build are not), per-key circuit retirement, and publishing the
   build (as deploy/epoxy publishes epoxy's) so a deploy serves it without
   a container build.
2. **epoxy over Tor streams** (done): the in-worker Wisp server for epoxy's
   function transport, credit and CLOSE mapping, UDP refusal.
3. **One client per profile** (done): the Tor client in a SharedWorker
   (`sharedWorker` on the descriptor), the transport workers of every tab
   its clients, started with `extendedLifetime` so a reload or a
   navigation keeps it in Chrome (a new Tor session gets a new session
   nonce from it, "Per-site circuits and New Identity"). Firefox and
   Safari have no such option: there a reload of the last page still
   starts the client again.
4. **Bootstrap UI** (done; S left): progress in the Tor toggle's tooltip from arti's log,
   and the blocker and a failure's reason from the client's own links
   ("Cannot reach the Wisp server", "No Tor relay answered") or from
   `bootstrapEvents` where tor-js has it; left: the tor-js side of
   `bootstrapEvents` (so "clock skew" and arti's other blockers show), the
   isolated mode.
5. **Fast-bootstrap snapshot** (done; S left): `scripts/tor-snapshot.mjs`
   builds `bootstrap.zip` with tor-js in Node (one-hop directory requests
   to the fallbacks, only a consensus arti has checked), the server serves
   it at `/tor-client/bootstrap.zip` from `STOMP_TOR_BOOTSTRAP` (and
   rebuilds it every `STOMP_TOR_BOOTSTRAP_EVERY` minutes), and a client
   with no consensus starts from it, its writes held until arti has loaded
   it ("The fast-bootstrap snapshot"); a first visit's Ready went from 1.0
   to 5.0 s (median 3.6 s) to 1.2 to 1.3 s. Left: the env (or a timer) on
   terp; in tor-js, reading the consensus's times from its preamble rather
   than with a full parse (about 0.15 s, a wasm build); in arti, the guard
   link before the directory is loaded (0.49 s).
6. **Tor-only Wisp endpoint** (M): `/wisp-or/` with the consensus allowlist,
   refreshed hourly (the snapshot builder's checked consensus has it); `STOMP_CONFIG.torClient.wisp`.
7. **Isolation UI** (done; S left): New Identity, New Tor circuit for this
   site and Tor circuit for this site in the menu, the last with the guard
   of the site's circuits (from arti's guard state and the kept consensus)
   and the site's circuit's age ("Circuit display"); left: the middle and
   exit relays and the countries, which tor-js does not expose (a tor-js
   patch returning a stream's circuit path, and arti's `tor-geoip` in its
   build), and the isolated mode.
8. **Guard state store** (done): the client's state in IndexedDB
   `stomp-tor-client`, outside the `tor` profile, one store wrapper for
   every start of the client, Forget Tor state in the menu (the store
   emptied and the client started again), store-names coverage ("Guard
   persistence"). tor-js has no call to forget the guards of a running
   client, so it is made again; a tab with a client of its own (no
   SharedWorker) is not restarted by another tab's Forget Tor state. A
   later visit reads it back by key range and uses a kept consensus only
   until its valid-until ("Bootstrap from the kept state"); left, in
   tor-js: reading the microdescriptors arti needs rather than all of them
   at start, and linking to the kept guard before the directory is loaded.
9. **Bridges** (L): WebTunnel (HTTPS + WebSocket, over Wisp TCP with epoxy's
   TLS, or the browser's own WebSocket) and Snowflake (WebRTC) as arti
   pluggable transports, so the operator does not see Tor use or the guard.
10. **Suites** (M; partly done): demo-tor, offline-html and the Firefox
    smoke's profile part run Tor mode on the stand-in, demo-tor-fail-closed
    runs Tor mode's own client code on a tor-js stand-in it breaks on
    purpose ("It fails closed"), and the Firefox smoke loads
    check.torproject.org through the real client when it has the network;
    left: a local test network (chutney) on CI, the deterministic one. The
    real-network smoke (`test/tor-client-smoke.mjs`) stays out of CI.
11. **Remove the relay** (done): `demo/torWisp.js`, `/wisp-tor/`, the
    `STOMP_TOR_*` settings (now a warning at startup), docs/tor.md's relay
    sections.
12. **Routes the worker does not answer** (done): Tor mode's routes are
    sealed with the siv codec and its worker answers every request at its
    routes itself, so the host's server never reads a site's address from
    a route ("It fails closed").
