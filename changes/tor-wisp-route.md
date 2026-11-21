### Transport

- Add an opt-in Tor route for proxied TCP traffic through a dedicated Wisp relay backed by Tor SOCKS5. The homepage Tor checkbox remembers the choice, keeps a profile of its own and refuses to fall back to direct Wisp when the relay is unavailable. UDP and HTTP/3 are disabled in Tor mode.
- The demo server watches whether its Tor can carry connections, not only whether its SOCKS port answers: Tor's control port (`STOMP_TOR_CONTROL`, SAFECOOKIE or password authentication), followed on one connection through Tor's bootstrap, circuit and network-liveness events as Brave does, with nothing asked while it is open; or, without one, the relay's own traffic, with a bounded SOCKS CONNECT probe through Tor (`STOMP_TOR_PROBE`) only when the relay is idle or its streams get nothing back. `GET /api/tor` says `down`, `bootstrapping` (with Tor's percentage), `ready` or `unknown`; `/wisp-tor/` takes connections only while Tor is ready and closes them when it stops being ready, and a relay configured while Tor is down starts anyway, so Tor coming up or coming back needs no restart (test/tor-wisp.mjs, demo-tor).

### Demo and API

- Tor mode is a STomp profile of its own on the same origin, like Brave's Tor window: its own cookie jar, site storage and native stores, HTTP and rewrite caches, permissions, passkeys, transport memories and extensions (none of the normal profile's). It is wiped when Tor is turned off and when the last Tor-mode tab closes, and the demo keeps none of its own history, bookmarks, settings or tabs from a Tor-mode page (demo-tor).
- `ControllerInit.profile` and `RemoteControllerInit.profile` open a profile's stores, apart from every other profile's on the origin; `StompController.register(dir, { profile })` registers its worker, `StompController.forgetProfile(id)` and `remoteController.forgetProfile(id)` delete all of it, and `StompController.profileWorker(id)` is its worker script's query for a host that registers it itself. Every store name is made in one place (`src/profile.ts`); test/store-names.mjs fails on one that is not.
- In Tor mode the page shows Tor's state beside the toggle and in the status line, and a page whose load failed while Tor was down or still connecting says so ("Tor is down", "Tor is connecting" with the percentage) and loads again by itself once Tor is ready, without a reload of the host page (demo-tor).

### Security

- The Tor relay refuses the ports browsers block, names with no dot, local and reserved names, Tor's `.exit` notation and numeric names before they reach Tor; keeps holyWisp's per-client limits on (per-destination ones are moot behind SOCKS); caps a connection at 512 streams, a connect through Tor at 60 s and an idle connection at 5 minutes; and can be limited to given page origins (`STOMP_TOR_ORIGINS`) and told its reverse proxies (`STOMP_TOR_TRUSTED_PROXIES`).

### Docs

- docs/tor.md: what Tor mode protects and what it does not (the relay operator sees addresses and destinations, circuits shared between sites, the host page outside Tor), Tor mode's profile and its wipe, the readiness checks, the relay's limits, an operator checklist, and what per-site circuits as in Brave would need of the relay.
