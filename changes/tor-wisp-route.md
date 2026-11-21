### Transport

- Add an opt-in Tor route for proxied TCP traffic through a dedicated Wisp relay backed by Tor SOCKS5. The homepage Tor checkbox remembers the choice, isolates its service worker data and refuses to fall back to direct Wisp when the relay is unavailable. UDP and HTTP/3 are disabled in Tor mode.
- The demo server watches whether its Tor can carry connections, not only whether its SOCKS port answers: Tor's control port (`STOMP_TOR_CONTROL`, `GETINFO status/bootstrap-phase`, SAFECOOKIE or password authentication) or, without one, a bounded SOCKS CONNECT probe through Tor (`STOMP_TOR_PROBE`). `GET /api/tor` says `down`, `bootstrapping` (with Tor's percentage), `ready` or `unknown`; `/wisp-tor/` takes connections only while Tor is ready and closes them when it stops being ready, and a relay configured while Tor is down starts anyway, so Tor coming up or coming back needs no restart (test/tor-wisp.mjs, demo-tor).

### Demo and API

- In Tor mode the page shows Tor's state beside the toggle and in the status line, and a page whose load failed while Tor was down or still connecting says so ("Tor is down", "Tor is connecting" with the percentage) and loads again by itself once Tor is ready, without a reload of the host page (demo-tor).

### Security

- The Tor relay refuses the ports browsers block, names with no dot, local and reserved names, Tor's `.exit` notation and numeric names before they reach Tor; keeps holyWisp's per-client limits on (per-destination ones are moot behind SOCKS); caps a connection at 512 streams, a connect through Tor at 60 s and an idle connection at 5 minutes; and can be limited to given page origins (`STOMP_TOR_ORIGINS`) and told its reverse proxies (`STOMP_TOR_TRUSTED_PROXIES`).

### Docs

- docs/tor.md: what Tor mode protects and what it does not (the relay operator sees addresses and destinations, one profile for both modes, the host page outside Tor), the readiness checks, the relay's limits, an operator checklist, and the options and costs of isolating Tor mode's profile.
