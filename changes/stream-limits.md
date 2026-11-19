### Transport

- The tabs of a host share Chrome's connection limits, as Chrome's tabs
  share their profile's one pool: six requests at a time to an HTTP/1
  server, 256 in all, and one WebSocket handshake at a time to a host and
  port. Each tab's transport kept its own (two tabs had twelve requests at
  once on a server, where Chrome has six), so with every tab on the carrier
  host's one wisp connection nine tabs could have 2304 requests on it, past
  holyWisp's 2048 streams a session. A transport asks the carrier host's
  pool, and its own only while it has no host to ask. The 255 WebSockets
  stay each tab's, as Chrome counts them per renderer process (two tabs
  open 130 each). `connection-limits` compares two tabs with Chrome.
- A stream the relay refuses past its limit (holyWisp's
  `max-streams-per-conn`, which its reputation's THROTTLE lowers: a CLOSE
  with 0x49) waits at the carrier host and goes again as streams close,
  on the same session and with no failure for the page; while one waits,
  new streams wait behind it. A stream held 30 s while none closed hears
  the refusal. Before, the page's request or WebSocket failed.
  `carrier-host` covers three tabs past a relay's limit.
- An idle connection of epoxy's pool is kept as Chrome 157 keeps one: an
  HTTP/1 connection is closed after 300 s idle and an HTTP/2 one stays
  until its server closes it (Chrome kept one 700 s, closing it only as
  the network changed), where both were closed after hyper-util's 90 s; a
  host keeps six idle at most. Needs the epoxy build with
  hyper-util-wasm 0053 and epoxy-tls 0081.
