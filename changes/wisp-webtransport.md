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
  `https:`. Wisp v2 is offered as the `wisp-v2` protocol. Nothing waits on
  UDP: a relay the origin has not met rides the WebSocket at once with a
  session tried beside it, one whose session worked rides it from the next
  start (within `timeoutMs`, 2 s, else the WebSocket), and one that failed
  is left to the WebSocket for five minutes or until the network changes,
  remembered in IndexedDB across reloads. A session that ends is revived as
  a lost WebSocket is (RevivingTransport), choosing its carrier again.
  `webtransport-wisp` covers it with a relay of the suite's and, when its
  build is on the machine, holyWisp's own.

### Demo and API

- The demo turns the WebTransport carrier on (`STOMP_WISP_WEBTRANSPORT=0`
  keeps the WebSocket; a URL names the session, or with `.json` its
  discovery document), with the built-in holyWisp's document forwarded at
  `/webtransport.json` when its package starts the listener; `?wt=0` or
  `?wt` decides for one visit. Each choice is on the console
  (`Stomp: wisp over WebTransport to ...`).
