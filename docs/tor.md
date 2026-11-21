# Tor mode

The demo's **Tor** toggle sends the TCP connections of proxied sites through
a Tor client on the demo's server. This page says what that protects and what
it does not, how the server tells whether Tor works, what an operator has to
do before offering it to the public, and what isolating Tor mode from normal
mode would cost. `demo/README.md` ("Tor routing") has the settings.

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
- **One profile for both modes.** Tor mode uses its own service worker
  scope (`/stomp-tor/`) and turns off STomp's HTTP cache, but the proxy
  origin's persistent databases are the same in both modes: the cookie jar,
  site storage (localStorage, IndexedDB and the rest), permissions, client
  hints, emulated service workers, passkeys and installed extensions. A site
  that set a cookie in normal mode gets it back in Tor mode, and a login
  carries over, which links the two. The host page's own state (history,
  bookmarks, open tabs, settings) is one set for both modes too.
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
printable characters), `via` (`control`, `probe`, `socks`, `relay` or
`external`) and `checked` (milliseconds since the last check). It names no
address, port or setting.

How the server knows, cheapest first:

1. A SOCKS5 greeting every 2 s until ready and every 5 s after (on this
   machine). No answer is `down` at once.
2. With `STOMP_TOR_CONTROL`, Tor's control port:
   `GETINFO status/bootstrap-phase` and `status/circuit-established` on the
   same schedule, each check a fresh connection bounded at 3 s. 100% with a
   circuit is `ready`; 100% without one (the network went away) is not.
   Authentication is whatever Tor offers of NULL, HASHEDPASSWORD
   (`STOMP_TOR_CONTROL_PASSWORD`) and SAFECOOKIE (the cookie file Tor names,
   or `STOMP_TOR_CONTROL_COOKIE`); the plain COOKIE method is never used,
   since it would hand the file's bytes to whatever listens on that port.
3. Without a control port, a SOCKS5 CONNECT through Tor to
   `STOMP_TOR_PROBE` (default `check.torproject.org:443`), closed as soon as
   Tor answers, without sending a byte to the destination: every 10 s until
   it works, every 5 minutes after, one at a time, bounded at 30 s. Two
   failures in a row take a ready Tor back to `bootstrapping`.
   `STOMP_TOR_PROBE=off` leaves only the greeting, and the state `unknown`.

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
   connects to `STOMP_TOR_PROBE` through Tor every 5 minutes.
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
8. **Watch it.** Alert on `/api/tor` not `ready`, on the Tor process, and on
   the relay's restarts; watch bandwidth and stream counts.
9. **Tell visitors what it is.** The toggle's tooltip says the host page,
   shared cookies, storage and extensions stay outside Tor; the privacy
   limits above belong on any public page that offers it.
10. **Test** with the real Tor before each rollout: an onion page and a
    clearnet page in Tor mode, Tor stopped (the page says "Tor is down" and
    the load fails at once) and started again (the page comes back by
    itself).

## Isolating Tor mode from normal mode

Today both modes share one profile (above). The choices, for the user to
make:

1. **Keep one profile, say so** (now). No cost. Logins and site data carry
   from one mode to the other, which defeats Tor's unlinkability for any
   site visited in both.
2. **A proxy origin of its own for Tor mode** (for example
   `tor.proxy.example`, or another port of the demo's server, as the site
   pool's slots are). The browser keeps every database, the Cache API, the
   service worker registrations and cookies per origin, so all of STomp's
   stores are separate with no change to the library, and stores added later
   are separate too. The host runs the isolated `RemoteController` against
   the mode's origin. Cost: a second origin to deploy (DNS, certificate,
   CORS and isolation headers), extensions installed again per mode (no
   sharing of their data either, which is the point), and the host page's
   own state (history, bookmarks, tabs) keyed by mode in the host's
   localStorage. This is the cleanest separation.
3. **Database names per scope in the library** (each `openDB` name, the jar,
   the transport worker's stores, passkeys, the Wisp carrier and ECH caches
   prefixed by the scope or a profile id). One origin, but some 15 stores to
   key, a migration for existing data, and a standing risk that a store added
   later is not keyed and leaks between modes. More code, weaker guarantee
   than 2.
4. **Ephemeral Tor mode** on top of 2 or 3: Tor mode's stores are wiped when
   it is turned off or the last Tor tab closes (with 2, a `Clear-Site-Data`
   answer from the Tor origin does all of it). Closest to Tor Browser's
   behaviour; costs logins that do not survive a session.

None of these gives Tor Browser's fingerprint uniformity or hides the
visitor's address from the relay operator.

## Tested

- `node --test test/tor-wisp.mjs`: the DNS stub, SOCKS and control-port
  parsing, control-port authentication (NULL, password, SAFECOOKIE; plain
  COOKIE and a port that does not know the cookie refused), the monitor
  through down, bootstrapping, ready, down and ready again with a fake
  control port, the circuit probe, the real holyWisp relay against a fake
  SOCKS (onion by name; UDP, IP literals, blocked ports and local names
  refused), and the demo server refusing `/wisp-tor/` until Tor is ready,
  closing its connections when Tor goes and taking new ones when it comes
  back.
- The `demo-tor` suite: the toggle and its separate scope, and a demo
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
