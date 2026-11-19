### Transport

- Wisp can ride the relay's WebTransport session instead of its WebSocket
  (`TransportDescriptor.webTransport`, off unless set, epoxy only), as
  holyWisp's WebTransport listener serves it: one bidirectional stream
  carries the Wisp packets (each after its u32 LE length) and a UDP
  stream's DATA goes as a datagram when it fits, so a lost packet of HTTP/3
  or WebRTC inside no longer holds up every other stream. The session is
  `url` (its certificate checked as any site's), or what a discovery
  document (`discovery`, or `/webtransport.json` on the wisp URL's origin)
  names with the certificate hashes to pin, or a `wss:` wisp URL dialed as
  `https:`; with neither option the `wss:` wisp URL's own host and path are
  dialed first and the document (kept for an hour, a 404 or a page that is
  not JSON being none) is asked only when that fails. Wisp v2 is offered as
  the `wisp-v2` protocol. UDP first: a relay the origin has not met opens
  the session and the WebSocket together and rides the session when its
  Wisp stream is up within half the WebSocket's time after it (150 to 400
  ms) with its handshake done within a tenth (50 to 100 ms, all a network
  that drops UDP costs), the other closed at once; one whose session worked
  rides it (within `timeoutMs`, 2 s, else the WebSocket); one that failed
  is left to the WebSocket for 30 s, then tried beside it on each start, so
  a recovered network is on the session from the next page; remembered in
  IndexedDB across reloads. A session that ends is revived as a lost
  WebSocket is (RevivingTransport), choosing its carrier again.
  `webtransport-wisp` covers it with a relay of the suite's and, when its
  build is on the machine, holyWisp's own.

### Demo and API

- The demo turns the WebTransport carrier on (`STOMP_WISP_WEBTRANSPORT=0`
  keeps the WebSocket; a URL names the session, or with `.json` its
  discovery document), with the built-in holyWisp's document forwarded at
  `/webtransport.json` when its package starts the listener; `?wt=0` or
  `?wt` decides for one visit. The host's console has a plain `[wisp]`
  line for each event of the carrier, as KrunkNative's console words them
  (`trying the WebTransport transport to <url>`, `WebTransport session
established in <ms> ms: wisp transport WebTransport (UDP/QUIC) to <url>
(epoxy, HTTP/3 on)`, `WebTransport unavailable (<why>), trying the next
transport; WebTransport again in 30 s`, `WebTransport skipped: it failed
<n> s ago (<why>); next try in <n> s`, `connecting to <wss url> (wisp
transport WebSocket (TCP); epoxy, HTTP/3 on)`, a session or WebSocket
  that ended, `reconnecting now`, `switched from WebTransport to
WebSocket`), `console.info` or `console.warn` for a failure, printed by
  the host's controller whether the transport runs in its worker, its page
  or the controller frame. A transport without `webTransport` reports its
  WebSocket the same way (one line, `..., WebTransport off; ...`), so the
  controller's `carrier` and its `carrier` event (also on
  `StompRemoteController`) are set for every transport given a wisp URL,
  and the demo shows it in About's Transport row alone (the carrier, its
  time, the relay and why not UDP), which takes the place of the demo's
  own Transport console line; the menu button's UDP or TCP tag and the
  carrier line atop the menu are gone. The demo turns the carrier on for its built-in holyWisp only when
  that serves its discovery document.
- The transport's verbose log (`ControllerInit.debugTransport`, off by
  default; `localStorage['stomp:debug-transport'] = '1'` on the host's
  origin, or the demo's `?transportdebug`): a `[net]` line on the host's
  console for each connection the transport opens to a site (HTTP/1.1 or
  HTTP/2 over TLS over a Wisp TCP stream, HTTP/3 over QUIC over a Wisp UDP
  stream, a WebSocket, a page's WebTransport session, WebRTC's streams),
  what its Wisp stream rides to the relay (WebTransport's QUIC stream or
  its datagrams, or the WebSocket), and each HTTP/3 fallback to TCP with
  its reason. Nothing is built for it while it is off. The demo's About has
  a Transport log row saying how to turn it on.
