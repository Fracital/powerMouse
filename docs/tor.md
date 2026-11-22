# Tor mode

The demo's **Tor** toggle puts proxied sites behind a **Tor client that runs
in the browser** (docs/tor-over-wisp.md has the design, the choice of client
and the measurements). The browser builds the Tor circuits itself, in the
transport worker: arti, the Tor Project's Rust client, compiled to wasm
(tor-js). The demo's server only carries TCP to Tor relays over its ordinary
Wisp endpoint. There is no server-side relay: the one this page used to
describe (a holyWisp in front of a tor daemon's SOCKS port, `/wisp-tor/`,
`STOMP_TOR_SOCKS5` and the other `STOMP_TOR_*` settings) is gone, because it
saw every destination of every visitor. This page says what Tor mode
protects and what it does not, and how its profile is kept apart.
`demo/README.md` ("Tor routing") has the settings.

## What it is, and what it is not

- **What our server sees.** It sees **that you use Tor, and which Tor guard
  relay you use** (the addresses your Wisp streams go to: your guards, and
  while the client bootstraps a fallback directory), with the times and
  amounts of your traffic, and your IP address, as your ISP does for any Tor
  user. It never sees the sites you visit, their names or what you send
  them: a Wisp stream carries Tor's link TLS to the guard, inside it cells
  encrypted to each hop, and inside those the site's own TLS. The client
  keeps its guards from visit to visit (as Tor Browser does), so the guard is
  also a sign that two visits are the same browser. **Bridges**, which would
  hide Tor use and the guard from our server, are future work.
- **The worker reaches only Tor relays.** Before a Wisp stream is opened,
  the transport worker checks that its address is a fallback directory arti
  has compiled in or a relay in the consensus the client holds, and refuses
  anything else, so not even a bug can send a site's traffic past Tor.
- **Sites see a Tor exit.** DNS is the exit's: a site's name goes in the
  stream's BEGIN cell, never to the browser's or the server's resolver. For
  `http://` sites the exit sees the content in the clear, as in Tor Browser.
- **A circuit per site.** Requests are isolated by the top-level site of the
  page that makes them, as Tor Browser's first-party isolation does: two
  sites never share a circuit. **New Tor circuit for this site** (the menu)
  gives the tab's site a new one, and **New Identity** starts a new Tor
  session: new circuits for everything and the Tor profile forgotten.
- **A profile of its own, for the session.** Tor mode has its own cookie
  jar, site storage, caches, permissions and extensions, apart from normal
  mode's on the same origin, and they are wiped when Tor mode is turned off
  and when its last tab closes ("Profiles" below). A site visited in both
  modes cannot link them by what it stored. It is still one browser: the
  host page's settings and bookmarks are read in both modes, and nothing
  hides that the same browser and address use both.
- **The host page is not proxied.** The page itself, `/config.js`, `/api/*`
  (the uptime, the commit list), the commit list's avatars (which the server
  fetches from GitHub), the installed-app worker and the fonts are the
  browser's own requests to their servers, from the visitor's address. Only what the controller's
  transport carries goes through Tor.
- **The browser is the visitor's.** STomp's fingerprint protections apply as
  in normal mode, which is not Tor Browser's uniform fingerprint. Screen size,
  fonts, GPU, time zone and language can still tell visitors apart.
- **TCP only.** Tor has no UDP, so HTTP/3, WebTransport and WebRTC's UDP
  candidates do not work in Tor mode, and the external ECH DNS lookup is
  off. Epoxy runs on Tor streams, so HTTP/2 and WebSockets work
  (docs/tor-over-wisp.md, "Epoxy on Tor streams").
- **Progress.** The Tor toggle's tooltip under **Settings > Proxy** (also
  in the browser hamburger's Proxy submenu) and the status line show the
  client's bootstrap in Tor Browser's phases (the toggle has no badge, like
  the others), what blocks it where the client can tell (the Wisp server
  cannot be reached, it refuses links to relays, no relay answers, or
  arti's own reason once tor-js reports it: docs/tor-over-wisp.md
  "Bootstrap progress and failures"), and a load that failed while it
  connected loads again by itself once it is ready. A load that failed
  because the client gave up says why.
- **It fails closed.** Tor mode's pages have no transport but the Tor
  client's: while it bootstraps a request waits, when bootstrap fails or no
  circuit builds the request fails, and a link the client asks for to
  anything but a relay is refused. Nothing falls back to a direct
  connection, in any tab or after a reload. A browser tab in Tor mode stays
  in it across its reloads even when another tab turned Tor off since; only
  its own toggle takes it out. `GET /api/tor` says only whether the
  server offers the client (`client`, or `off` with `STOMP_TOR_CLIENT=0`).

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
uniformity, and does not hide from our server that the visitor uses Tor.

## Per-site circuits

Brave gives each first-party site its own circuits: the SOCKS username of
every connection is the top frame's site (`AnonymizationKeyToString` in
`net/proxy_resolution/proxy_config_service_tor.cc`) and the password a
random nonce per site, renewed after about ten minutes and on "New Tor
connection for this site" (`TorProxyMap`). The client does the same with
arti's stream isolation: each request's key is its top-level site (the
service worker's `$stomp$network` field), a nonce for that site and a nonce
for the session; New Tor circuit for this site renews the site's nonce, New
Identity the session's. arti retires a circuit after ten minutes of use, as
tor does.

## Tested

- `node --test test/store-names.mjs`: every store STomp opens is named in
  its profile.
- The `demo-tor` suite: the toggle, its separate scope and Tor mode's
  transport (the server's `STOMP_TOR_CLIENT=stand-in`: epoxy in the client's
  place, since the suites reach no Tor network); in the same origin and the
  isolated mode, a site's cookie, localStorage, IndexedDB and Cache Storage
  of one mode are not in the other, every store Tor mode opened on the
  origin is its profile's and none is shared, the origin's databases,
  caches, keys, directories and workers have nothing of Tor mode left once
  it is turned off or its last tab closes, its history was never kept, the
  normal profile's data outlives it, and a new session gets a new worker;
  and a deployment without Tor refuses Tor mode rather than browse directly.
- The `demo-tor-fail-closed` suite: Tor mode's own client code (transport,
  SharedWorker, service, its Wisp links and relay check) with tor-js
  replaced by a stand-in the suite breaks on purpose
  (`STOMP_TOR_CLIENT=stand-in-arti`, test/offline-tor-stand-in.mjs). With
  bootstrap that never ends (in one tab, a second tab and after a reload),
  bootstrap that fails at the Wisp server, no circuit building (two tabs)
  and a client that dials the site itself, the fixture page asked for is
  never reached; the page says why bootstrap failed or is blocked, a
  failure is followed by a working retry, a Tor tab stays in Tor mode when
  another turns it off, and a Tor tab's reload keeps its session's site
  data while the normal tab beside it never sees it. It reaches no Tor
  network.
- `node test/tor-client-smoke.mjs`: the real client against the real Tor
  network (docs/tor-over-wisp.md, "Prototype").
