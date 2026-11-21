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
  connects to, with timing and volume;
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
2. With no usable consensus, arti connects to one of its built-in fallback
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

A fast-bootstrap snapshot (`bootstrap.zip.zst`, tor-js's gateway format:
consensus, certificates and microdescriptors, about 3 MB) can be served from
the app's own origin, refreshed hourly from the server's copy. The client
checks its signatures as it checks a download, so it lends no trust to the
server, and our server already knows the visitor's address (it serves the
page), so the reason tor-js makes it optional (a gateway learns who uses
Tor) does not apply. It turns a first bootstrap's many one-hop directory requests into one HTTPS
download. Not in the
prototype; measured times are in "Prototype".

**Progress** follows Tor Browser's bootstrap phases, which arti's
`BootstrapStatus` reports as a fraction and a blocker: "Connecting to a
relay", "Loading directory" (consensus), "Loading relay descriptors" (n of
m microdescriptors), "Building a circuit", "Connected". The transport posts
them to the controller as a transport event and the Tor toggle's tooltip shows the
percentage and the phase, the way `watchTor` shows `/api/tor` today, which in
client mode reads the transport, not the server.

### Guard persistence

Tor's security against a hostile guard rests on keeping few guards for
months. Tor mode's profile is forgotten when its last tab closes; if the
client's state lived in it, every session would sample new guards, which
over time hands a hostile guard many chances. So, like Tor Browser (whose
New Identity keeps `state` and its guards), **the client's state is not part
of the `tor` profile's site data**: it is one store of its own, kept across
sessions and New Identity, holding only guards and public directory data,
forgotten only by an explicit "Forget Tor state" and by clearing site data
of the host. Its name goes through `profileStoreName` (`test/store-names.mjs`).

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
the tab runs a client of its own in its transport worker. The client ends
with the origin's last page. The client is tor-js 0.4.4 with deploy/tor-js's stream API
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
since they share the identity) and **New Tor circuit for this site** (a new
isolation nonce for the tab's site, and the tab loads again). The channel is
same-origin, so in the isolated mode (the controller in the proxy's frame)
the page hears nothing and the two items are not offered; the dialing mode,
which production uses, is same-origin.

`node test/tor-client-smoke.mjs` (after `node build.js`; `SKIP_NETWORK=1`
skips it, and it is not a suite: it needs the public Tor network) starts a
demo server of its own with holyWisp logging every stream, opens the demo
with `?tor=1` in the suites' Chrome (`--host-resolver-rules` resolves no
name but localhost, so nothing but the Wisp connection leaves), loads
`https://check.torproject.org/api/ip`, `https://api.ipify.org/?format=json`
and the first again, keeps the session 90 s, opens a fresh host page (a new
transport worker and client) and loads the first site once more. It checks
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
- **A reload starts the client again** where it was the origin's only page
  (the SharedWorker ends with it): a warm bootstrap, 1 to 2 s. The carrier
  host's `extendedLifetime` (Chrome 157) would keep it across reloads.
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

## Remaining work

The client is Tor mode. What it still needs
to be as good as Tor Browser's, with rough sizes (S under a day, M a few
days, L a week or more).

1. **Stream API in tor-js** (done; S left): `connect(host, port,
isolationKey)` (deploy/tor-js `0001`); left: `resolve()`,
   `bootstrap_events()`, per-key circuit retirement, and publishing the
   build (as deploy/epoxy publishes epoxy's) so a deploy serves it without
   a container build.
2. **epoxy over Tor streams** (done): the in-worker Wisp server for epoxy's
   function transport, credit and CLOSE mapping, UDP refusal.
3. **One client per profile** (done; S left): the Tor client in a
   SharedWorker (`sharedWorker` on the descriptor), the transport workers of
   every tab its clients; left: `extendedLifetime`, so a reload keeps it.
4. **Bootstrap UI** (done; S left): progress in the Tor toggle's tooltip from arti's log;
   left: arti's own `bootstrap_events()` through tor-js, an error state with
   the blocker ("cannot reach any relay", "clock skew"), the isolated mode.
5. **Fast-bootstrap snapshot** (S): the server builds `bootstrap.zip.zst`
   hourly (tor-js's gateway crate or a fetch of the consensus over Tor) and
   serves it from the app origin; the client passes it as `bootstrap`.
6. **Tor-only Wisp endpoint** (M): `/wisp-or/` with the consensus allowlist,
   refreshed hourly; `STOMP_CONFIG.torClient.wisp`.
7. **Isolation UI** (done; S left): New Identity and New Tor circuit for this
   site in the menu; left: the circuit display (Tor Browser's "Circuit for
   this site") from arti's circuit info, the isolated mode.
8. **Guard state store** (S): the client's state outside the `tor` profile,
   its own "Forget Tor state", store-names coverage.
9. **Bridges** (L): WebTunnel (HTTPS + WebSocket, over Wisp TCP with epoxy's
   TLS, or the browser's own WebSocket) and Snowflake (WebRTC) as arti
   pluggable transports, so the operator does not see Tor use or the guard.
10. **Suites** (M; partly done): demo-tor, offline-html and the Firefox
    smoke's profile part run Tor mode on the stand-in, and the Firefox
    smoke loads check.torproject.org through the real client when it has
    the network; left: a local test network (chutney) on CI, the
    deterministic one. The real-network smoke (`test/tor-client-smoke.mjs`)
    stays out of CI.
11. **Remove the relay** (done): `demo/torWisp.js`, `/wisp-tor/`, the
    `STOMP_TOR_*` settings (now a warning at startup), docs/tor.md's relay
    sections.
