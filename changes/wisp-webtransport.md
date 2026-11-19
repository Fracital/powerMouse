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
  `?wt` decides for one visit. Each choice is one line on the console
  (`STomp transport  Wisp over WebTransport (UDP/QUIC) to <url>, <ms> ms`,
  or the WebSocket's with why not WebTransport, and a line when a revived
  transport switches), and the controller's `carrier` and its `carrier`
  event say it (also on `StompRemoteController`).
