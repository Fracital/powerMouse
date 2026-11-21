# Tor mode

Tor mode is the in-browser Tor client wherever the server runs no relay:
the browser builds the circuits and the server's Wisp carries only TCP to
Tor relays (docs/tor-over-wisp.md). **Our server still sees that you use
Tor, and which Tor guard relay you use** (the addresses your Wisp streams
go to), with the times and amounts of your traffic; it never sees
the sites you visit or what you send them. Bridges, which would hide Tor
use and the guard from it, are future work. This page is about the server-side
relay a deployer can still configure instead (`STOMP_TOR_SOCKS5`,
`STOMP_TOR_WISP_URL`), which is to be removed; its Profiles section holds for
both.

The demo's **Tor** toggle sends the TCP connections of proxied sites through
a Tor client on the demo's server. This page says what that protects and what
it does not, how Tor mode's profile is kept apart from normal mode's, how the
server tells whether Tor works, what an operator has to do before offering it
to the public, and what per-site circuits would need. `demo/README.md` ("Tor
routing") has the settings.

## What it is, and what it is not

It is **server-side Tor egress for proxied sites**: the browser's transport
(epoxy, with TLS in the browser) opens its Wisp connection to `/wisp-tor/` on
the demo's server instead of `/wisp/`, and that relay (holyWisp,
`demo/torWisp.js`) hands every TCP stream by hostname to the Tor SOCKS5
listener on the same machine. Sites, `.onion` services included, see a Tor
exit or a rendezvous circuit, not the server's address and not the visitor's.

It is **not Tor Browser** and it is not browser-wide anonymity:

- **The relay operator sees who goes where.** The Wisp relay is the demo's
  server. It sees the visitor's IP address, and every destination hostname and
  port the visitor's proxied pages connect to, with the time and the amount of
  data. For `https://` sites the content is TLS from the browser and the
  operator cannot read it. For `http://` sites, `http://` onion services
  included, the relay (and, for a non-onion site, the Tor exit) sees the
  content in the clear.
- **A profile of its own, for the session.** Tor mode has its own cookie
  jar, site storage, caches, permissions and extensions, apart from normal
  mode's on the same origin, and they are wiped when Tor mode is turned off
  and when its last tab closes ("Profiles" below). A site visited in both
  modes cannot link them by what it stored. It is still one browser: the
  host page's settings and bookmarks are read in both modes, and nothing
  hides that the same browser and address use both.
- **One circuit for many sites and visitors.** Tor picks circuits by what
  the SOCKS client tells it, and the relay's streams all come from one
  client with no SOCKS credentials, so sites (and visitors) share circuits
  for as long as Tor reuses one (ten minutes by default). An exit sees
  them together. "Per-site circuits" below has what would change it.
- **The host page is not proxied.** The page itself, `/config.js`, `/api/*`
  (Tor's state, the uptime, the commit list), the commit list's avatars from
  GitHub, the installed-app worker and the fonts are the browser's own
  requests to their servers, from the visitor's address. Only what the
  controller's transport carries goes through Tor.
- **The browser is the visitor's.** STomp's fingerprint protections apply as
  in normal mode, which is not Tor Browser's uniform fingerprint. Screen size,
  fonts, GPU, time zone and language can still tell visitors apart.
- **TCP only.** UDP is refused, so HTTP/3, WebTransport and WebRTC's UDP
  candidates do not work in Tor mode. The external ECH DNS lookup is off.

## Readiness

A SOCKS5 greeting only proves that something listens on the port: a Tor that
is still bootstrapping, or that lost its network, answers it too and then
holds each CONNECT for up to two minutes. So the server watches Tor
(`createTorMonitor` in `demo/torWisp.js`) and says what it sees at
`GET /api/tor`:

| `state`         | Meaning                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `off`           | no Tor relay is configured on this server                                                    |
| `down`          | the relay is not running, or nothing answers on Tor's SOCKS port                             |
| `bootstrapping` | Tor answers but has no working circuit yet (`progress` is Tor's percentage when known)       |
| `ready`         | Tor has a working circuit                                                                    |
| `unknown`       | Tor answers and nothing more is known: an external relay, or the circuit probe is turned off |

The answer also has `summary` (Tor's own words for the phase, at most 80
printable characters), `via` (`control`, `probe`, `traffic`, `socks`,
`relay` or `external`) and `checked` (milliseconds since the last check; 0
while the control port is followed). It names no address, port or setting.

How the server knows, cheapest first:

1. A SOCKS5 greeting every 2 s until ready and every 5 s after (on this
   machine, no circuit). No answer is `down` at once.
2. With `STOMP_TOR_CONTROL`, Tor's control port, followed as Brave follows
   its Tor (`components/tor/tor_control.cc` in brave-core): one connection
   kept open, which authenticates, subscribes with
   `SETEVENTS STATUS_CLIENT NETWORK_LIVENESS`, asks
   `GETINFO status/bootstrap-phase` and `status/circuit-established` once,
   and then only listens. Tor's `BOOTSTRAP PROGRESS=` events move the
   percentage, `CIRCUIT_ESTABLISHED` and `CIRCUIT_NOT_ESTABLISHED` say
   whether it has a circuit, and `NETWORK_LIVENESS DOWN` that it lost the
   network. 100% with a circuit is `ready`; 100% without one is not. Nothing
   is asked while it is open. When it closes (Tor stopped or restarts), Tor
   is checked again at once and the connection opened again every 2 s.
   Authentication is whatever Tor offers of NULL, HASHEDPASSWORD
   (`STOMP_TOR_CONTROL_PASSWORD`) and SAFECOOKIE (the cookie file Tor names,
   or `STOMP_TOR_CONTROL_COOKIE`); the plain COOKIE method is never used,
   since it would hand the file's bytes to whatever listens on that port.
3. Without a control port, the relay's own traffic: bytes that came back to
   a visitor from a destination went through a working circuit, so the
   relay's counters (holyWisp's `stats()`, read every 5 s on this machine)
   are the signal, and nothing goes through Tor to learn it. The circuit
   probe, a SOCKS5 CONNECT through Tor to `STOMP_TOR_PROBE` (default
   `check.torproject.org:443`) closed as soon as Tor answers without
   sending a byte to the destination, bounded at 30 s and one at a time,
   runs only when the traffic says nothing: every 10 s until the first
   evidence and after a failed probe; when streams were opened and nothing
   came back for 20 s (then two failed probes in a row take a ready Tor
   back to `bootstrapping`); and when nothing went through for 5 minutes.
   While visitors browse, it does not run. `STOMP_TOR_PROBE=off` leaves only
   the greeting, and the state `unknown`.

Polling `/api/tor` cannot make the server check more than once a second, and
only one check runs at a time.

What the server does with it:

- `/wisp-tor/` takes a new WebSocket only in `ready` (or `unknown`); in any
  other state it answers `503` at once. Nothing is ever sent to `/wisp/`
  instead.
- When Tor stops being ready, every open `/wisp-tor/` connection is closed,
  so the requests on them fail at once instead of waiting for the connect
  timeout, and the transport's next connection waits for Tor.
- The WebKit sync relay of the Tor scope (`/stomp-tor/sync-relay`) answers
  `503` in the same states.
- A relay configured while Tor is down still starts, and is advertised in
  `/config.js`: Tor coming up later, or coming back, needs no restart.

What the page does with it (`demo/public/pm/main.js`, `watchTor`): while Tor
mode is on it asks `/api/tor` every 2 s until ready and every 15 s after (not
while the tab is hidden) and shows the state beside the toggle (`down`, the
percentage, `on`) and in the status line. A page whose load failed while Tor
was not ready gets the demo's error page (`demo/public/error.html`) titled
"Tor is down" or "Tor is connecting", which asks the same question every 2 s
and loads the page again by itself once Tor is ready. The host page is never
reloaded for it.

## Relay hardening

The Tor relay is a holyWisp of its own (`startTorWisp`), separate from
`/wisp/`:

- **Tor only.** Every TCP stream goes to the SOCKS5 listener by hostname
  (`socks5h`, ATYP 3), so Tor resolves names and `.onion` works. IP-literal
  destinations are refused (`allowDirectIP: false`), UDP is refused
  (`allowUDP: false`, `proxyUDP: 'refuse'`), and there is no direct path.
  The SOCKS listener must be on loopback, without credentials.
- **No destination lookups outside Tor.** holyWisp checks a name with DNS
  before it dials; its only resolver is a loopback stub that never asks
  anyone and answers a fixed public placeholder (`1.1.1.1`, never dialled).
  The stub answers NXDOMAIN, so the stream is refused before Tor sees it,
  for names with no dot, `localhost` and `.local`, `.lan`, `.internal`,
  `.intranet`, `.home.arpa`, the reverse zones, the reserved `.test`,
  `.example` and `.invalid`, Tor's `.exit` and `.noconnect` notations, and a
  numeric last label (`0x7f.1`).
- **No private destinations.** Loopback, private and link-local addresses
  are refused as literals; a name that resolves to one does so at the Tor
  exit, whose exit policy rejects private addresses (Tor's default
  `ExitPolicyRejectPrivate`). `WISP_ALLOW_LOOPBACK` does not relax the Tor
  relay; the suites reach their fixture through a fake Tor instead
  (`test/torFakes.mjs`).
- **Ports.** The ports the Fetch standard blocks (mail, SSH, IRC, ...,
  `src/server/badPorts.ts`) are refused, as a browser refuses them.
- **Limits.** At most 512 streams on one Wisp connection; a stream whose
  connect (through Tor) takes over 60 s is closed with a Wisp CLOSE, enough
  for an onion service's first connection; a connection with no stream that
  sends nothing for 5 minutes is closed; holyWisp's per-client limits are on
  (new WebSockets per address per 10 s, connects per second, connects in
  flight, concurrent connections). Its per-destination limits are not:
  every destination looks like the one placeholder address to it, so they
  would be one limit for all sites and visitors. The SYN-flood heuristic is
  off too, since slow or failed Tor circuits look like failed handshakes.
- **A crash stays Tor-only.** holyWisp restarts its process with the same
  settings; meanwhile its `route()` answers 503 and the state is `down`. A
  dead DNS stub kills the relay.

What the relay does not have: Wisp authentication (epoxy does not speak Wisp
v2 passwords), a per-visitor bandwidth cap, or logging of its own.

## Operator checklist

Before offering Tor mode to the public:

1. **Run Tor as a client only** on the same machine
   (`SocksPort 127.0.0.1:9050`, no `ORPort`, no `ExitRelay`), from the distribution's
   package, kept updated.
2. **Give it a control port for readiness**, local only:
   `ControlPort 127.0.0.1:9051` or `ControlSocket`, with `CookieAuthentication 1` (the
   demo uses SAFECOOKIE) or `HashedControlPassword`. Set
   `STOMP_TOR_CONTROL` (and `STOMP_TOR_CONTROL_COOKIE` if the server cannot
   read the path Tor names, or `STOMP_TOR_CONTROL_PASSWORD`). The server's
   user must be able to read the cookie file. Without one, the circuit probe
   connects to `STOMP_TOR_PROBE` through Tor when the relay has been idle
   for 5 minutes or its streams get nothing back.
3. **Configure one Tor route**: `STOMP_TOR_SOCKS5` (this relay) or
   `STOMP_TOR_WISP_URL` (an external one, whose Tor egress, DNS, UDP
   refusal and readiness are then yours to guarantee: the page shows its
   state as unknown).
4. **Know who the client is.** The per-client limits count the address the
   Node server's socket sees. Behind a reverse proxy (nginx, a CDN) every
   visitor is that proxy unless `STOMP_TOR_TRUSTED_PROXIES` lists it and it
   sets `X-Forwarded-For`; holyWisp's README, "Who the client is".
5. **Restrict who can open it from a browser**: `STOMP_TOR_ORIGINS` lists
   the proxy origins whose pages may connect (a client that sends no
   `Origin` is never refused, so this is not authentication).
6. **Rate-limit and cap bandwidth in front of it** (the reverse proxy's
   limits on `/wisp-tor/`), and decide what one visitor may use: the relay
   has no bandwidth cap of its own.
7. **Logs.** holyWisp logs at `HOLYWISP_LOG_LEVEL` (`error` by default);
   `debug` writes every destination with the client address. Keep it off in
   production, and keep the reverse proxy's access logs for `/wisp-tor/` as
   short as the abuse handling allows. The demo logs Tor's state changes
   (`Tor: ready (control)`) and nothing of Tor's settings or credentials.
8. **Isolate circuits by destination** until the relay can isolate them by
   site ("Per-site circuits"): `SocksPort 127.0.0.1:9050 IsolateDestAddr`,
   so streams to different hosts do not share a circuit.
9. **Watch it.** Alert on `/api/tor` not `ready`, on the Tor process, and on
   the relay's restarts; watch bandwidth and stream counts.
10. **Tell visitors what it is.** The toggle's tooltip says the host page
    stays outside Tor and that Tor mode has its own cookies, storage,
    history and no extensions, gone when no tab is in Tor mode; the privacy
    limits above belong on any public page that offers it.
11. **Test** with the real Tor before each rollout: an onion page and a
    clearnet page in Tor mode, Tor stopped (the page says "Tor is down" and
    the load fails at once) and started again (the page comes back by
    itself).

## Profiles

Tor mode is a STomp profile of its own (`src/profile.ts`), on the same
origin as normal mode, kept like Brave's Tor window: Brave opens it as an
off-the-record profile (`Profile::OTRProfileID::TorID()`,
`browser/tor/tor_profile_manager.cc`) whose data goes with its last window.

**One place names every store.** A store of the default profile keeps the
name STomp always gave it; a store of another profile ends with `|` and the
profile's id (`stompCookies|tor`), so a name says which profile it is of
(`profileOfName`). STomp's own stores take their names from `storeName` in
the realm's profile: the service worker and the transport worker read it
from their script's URL (`serviceWorker.js?profile=tor`), and a controller's
page is told it (`ControllerInit.profile`, `RemoteControllerInit.profile`);
one page opens one profile's stores, and a worker refuses a controller of
another profile. The stores a proxied site makes natively (its IndexedDB
databases, caches, storage partitions, Web Locks, BroadcastChannels,
SharedWorkers, origin private file system and legacy file system
directories) are suffixed with its storage key in the profile
(`Client.nativeKey`). `test/store-names.mjs` reads the source and fails on
a store opened by a name of no profile, so a store added later cannot be
shared by accident.

What Tor mode has of its own, then: the cookie jar, the sites' storage and
their native stores, the HTTP cache and the rewriter's cache (on in Tor
mode, gone with it), the content blocker's lists, permissions and device
grants, client hints, emulated service workers, passkeys, the transport's
memories (ECH configs, the Wisp carrier), the anti-fingerprinting seed and
the tab ids, and its installed extensions. Storage Buckets are not offered
to Tor-mode pages (a bucket's name cannot carry the profile), and the site
pool is off in Tor mode (its slots are other origins, which the host page
cannot wipe).

**Ephemeral.** `StompController.forgetProfile('tor')` unregisters the
profile's service workers, then deletes its databases (a connection of
STomp's closes when its database is deleted, so the deletion does not
wait), caches, localStorage keys, this tab's sessionStorage keys and file
system directories, and says what it could not delete. A forgotten
profile's next worker is a new one (`StompController.profileWorker`: its
script's URL carries a name the wipe changes), since Chrome gives a scope
registered again soon after its unregistration the same running worker
back, memory and all. The isolated mode's `RemoteController.forgetProfile`
does the same on the proxy origin. The demo (`demo/public/pm/main.js`,
"Tor mode's session") forgets the profile:

- when Tor mode is turned off in its tab, once that page is gone;
- when the last Tor-mode tab closes while a normal one is open, after 10 s
  (a reload, which continues its session, takes its tab's Web Lock again
  before that);
- before the first Tor-mode tab of a new session starts (a browser closed
  with a Tor tab open, a tab restored), and whenever a page of the origin
  starts with no Tor-mode tab open.

Each Tor-mode page holds a Web Lock of its own; the decision to forget is
taken under one more, so two pages never wipe a session a third one opens.

**The host page's own data.** In Tor mode the demo keeps nothing of its
own (`demo/public/pm/profile.js`): what it writes of its settings,
bookmarks, omnibox history and tabs lasts only the page. It reads the
normal profile's settings and bookmarks, as Brave's Tor window inherits
them, but not its history. The tab's session (open tabs, the address bar)
is kept under the profile's sessionStorage keys, so a reload continues it,
and a new session starts without them.

**Extensions.** Tor mode starts with none: the normal profile's are not in
its store. One installed in Tor mode is the profile's and goes with it.
Brave runs an extension in its Tor window only when the user allowed it
("Allow in Private"), and then the same extension with the same id spans
both profiles. STomp has no such opt-in yet: it would take the extension's
package, its id (a Web Store package's comes from its CRX key) and the
choice from the normal profile's worker to the Tor profile's at the start
of each session, and an answer for its state (Chrome's "split" mode, a
copy per profile).

What stays shared: the host page itself and its requests (outside Tor, as
above), its theme, and the browser's own state for the origin that is not
STomp's (the origin's permission prompts the browser shows, its HTTP cache
of the demo's files). Tor mode gives no Tor Browser fingerprint
uniformity, and does not hide the visitor's address from the relay
operator.

## Per-site circuits

Brave gives each first-party site its own circuits: the SOCKS username of
every connection is the top frame's site (`AnonymizationKeyToString` in
`net/proxy_resolution/proxy_config_service_tor.cc`) and the password a
random nonce per site, renewed after about ten minutes and on "New Tor
connection for this site" (`TorProxyMap`), and Tor's default
`IsolateSOCKSAuth` keeps streams with different credentials on different
circuits.

The relay cannot do that yet. holyWisp (0.5.3) dials one upstream SOCKS
proxy with fixed credentials, and a Wisp stream says only its host and port,
not the site whose page opened it, so every visitor's every stream reaches
Tor as the same client. What it would take:

1. **The transport keys connections by first-party site**: the page's top
   site (the storage key's first part) for every stream a page opens, the
   way it already names the Partition.
2. **One Wisp connection per first-party site and profile** (or a Wisp
   extension that carries an isolation key per stream), so the relay can
   tell them apart.
3. **holyWisp takes a SOCKS username per connection** from the server's
   `route()` (the Node API decides the connection; a header or the route's
   path carries the key), and sends it with a password the server draws per
   visitor and site and forgets with the profile.

Until then, `SocksPort 127.0.0.1:9050 IsolateDestAddr` (checklist above)
keeps streams to different hosts off one circuit, at the cost of more
circuits; streams of different visitors to the same host still share one.

## Tested

- `node --test test/tor-wisp.mjs`: the DNS stub, SOCKS and control-port
  parsing, control-port authentication (NULL, password, SAFECOOKIE; plain
  COOKIE and a port that does not know the cookie refused), Tor's events,
  the monitor through down, bootstrapping, ready, down and ready again with
  a fake control port that sends them (one connection, no command asked
  while it is open, SOCKS lost under an open control port), the network
  going away and coming back, the circuit probe, the relay's traffic as the
  signal (no probe while it flows, a probe when idle, a stall that probes
  and fails, recovery), the real holyWisp relay against a fake
  SOCKS (onion by name; UDP, IP literals, blocked ports and local names
  refused), and the demo server refusing `/wisp-tor/` until Tor is ready,
  closing its connections when Tor goes and taking new ones when it comes
  back.
- `node --test test/store-names.mjs`: every store STomp opens is named in
  its profile.
- The `demo-tor` suite: the toggle and its separate scope; in the same
  origin and the isolated mode, a site's cookie, localStorage, IndexedDB
  and Cache Storage of one mode are not in the other, every store Tor mode
  opened on the origin is its profile's and none is shared, the origin's
  databases, caches, keys, directories and workers have nothing of Tor mode
  left once it is turned off or its last tab closes, its history was never
  kept, the normal profile's data outlives it, and a new session gets a new
  worker; and a demo
  server of its own with the real relay in front of a fake Tor whose SOCKS
  connects every name to the fixture: Tor down (the page says so, a load
  fails at once with "Tor is down"), bootstrapping (its percentage),
  ready (the failed page loads by itself), down again and back, all without
  reloading the host page.
- Once by hand (2026-11-20), the machine's own Tor without a control port:
  `/api/tor` was `ready` through the probe about a second after start, and
  the Tor Project's onion service
  (`2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion`) loaded
  in headless Chrome with `?tor=1`, its title and first heading in about
  6 s.
