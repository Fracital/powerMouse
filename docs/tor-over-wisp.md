# Tor over Wisp: a Tor client in the browser

Status: design, with an opt-in prototype (`?tor=client`, "Prototype" below).
Today's Tor mode (docs/tor.md) is server-side Tor egress: the demo's server
runs a Wisp relay (`/wisp-tor/`, `demo/torWisp.js`) that hands each TCP stream
to a tor daemon's SOCKS port. That relay sees every destination host and port
of every visitor, and it can tell visitors' streams apart only by connection.
This page is the design that replaces it: **the browser builds the Tor
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
docs/tor.md "What it is, and what it is not", which still holds apart from the
relay paragraphs).

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

### Tor mode today

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
  `ready`, ...); main.js `watchTor` polls it for the Tor chip.
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
   already get right); without it, the prototype uses tor-js's own `fetch`.
2. **Bootstrap events**: arti's `bootstrap_events()` (percent and blocker),
   for a Tor Browser style progress bar. The prototype reads its log lines.
3. **New identity**: drop the circuits of a key (arti's
   `isolated_client()` / `retire_all_circs`), for "New circuit for this site".

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
them to the controller as a transport event and the Tor chip shows the
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
  WebRTC's UDP candidates. **WebSocket** is refused too for now, as decided
  for this work; note that it is TCP, Tor carries it and Tor Browser allows
  it, so with the stream API it is one flag to allow later.
- **Isolation of the wire format**: the transport takes the
  `$stomp$network` field and never sends it (`fieldSupport.partition`).

The prototype has no stream API, so its `request()` is tor-js's `fetch`
(arti's HTTP/1.1 client with rustls in the same wasm: still end to end, still
DNS at the exit), and `connect()` refuses.

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

## The existing relay

**Recommendation: remove it** once the client is the default, and do not offer
it as "Tor" before then. A server that sees every destination of every visitor
and links them by connection is the opposite of what Tor mode promises, and a
deployer who wants server-side egress through Tor for their own reasons can
point `STOMP_WISP_URL` at their own Wisp server with a SOCKS upstream: STomp
needs no code for that. Until the client is default, `/wisp-tor/` stays behind
the deployer's explicit `STOMP_TOR_SOCKS5`, and the in-browser client is the
opt-in.

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
  pick circuits apart; one client per origin and profile in a SharedWorker
  (as the carrier host is) is the remedy ("Remaining work").

## Remaining work to make this the default Tor mode

Rough sizes (S under a day, M a few days, L a week or more):

1. **Stream API in tor-js** (M): `connect(host, port, isolationKey)` and
   `resolve()` bindings in `crates/tor-js`, built from source in a container
   like `deploy/epoxy/` (`deploy/tor-js/`, pinned revisions, reproducible
   hash), plus `bootstrap_events()` and per-key circuit retirement.
2. **epoxy over Tor streams** (M): the in-worker Wisp server for epoxy's
   function transport, credit and CLOSE mapping, UDP refusal; Tor mode's
   descriptor becomes epoxy with that function transport.
3. **One client per profile** (M): the Tor client in a SharedWorker (the
   carrier host's pattern), the transport workers of every tab its clients.
4. **Bootstrap UI** (S): progress events to the Tor chip, an error state with
   the blocker ("cannot reach any relay", "clock skew").
5. **Fast-bootstrap snapshot** (S): the server builds `bootstrap.zip.zst`
   hourly (tor-js's gateway crate or a fetch of the consensus over Tor) and
   serves it from the app origin; the client passes it as `bootstrap`.
6. **Tor-only Wisp endpoint** (M): `/wisp-or/` with the consensus allowlist,
   refreshed hourly; `STOMP_CONFIG.torClient.wisp`.
7. **Isolation UI** (S): New circuit for this site, New Identity wired to
   the nonces and pools; the circuit display (Tor Browser's "Circuit for this
   site") from arti's circuit info.
8. **Guard state store** (S): the client's state outside the `tor` profile,
   its own "Forget Tor state", store-names coverage.
9. **Bridges** (L): WebTunnel (HTTPS + WebSocket, over Wisp TCP with epoxy's
   TLS, or the browser's own WebSocket) and Snowflake (WebRTC) as arti
   pluggable transports, so the operator does not see Tor use or the guard.
10. **Suites** (M): demo-tor and the Firefox smoke rewritten for the client:
    a local test network (chutney) on CI is the deterministic one; the
    real-network smoke (`test/tor-client-smoke.mjs`) stays out of CI.
11. **Remove the relay** (S): `demo/torWisp.js`, `/wisp-tor/`, `/api/tor`'s
    relay states, docs/tor.md's relay sections.
