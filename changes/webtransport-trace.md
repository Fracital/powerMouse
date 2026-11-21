### Transport

- In the verbose transport mode (`debugTransport`, or the host origin's
  `localStorage['stomp:debug-transport'] = '1'`) every WebTransport session
  a proxied page makes ends in one `[wt]` line on the host's console naming
  the stage that failed: the Wisp UDP stream (with the relay's close reason,
  0x48, 0x41, 0x03 ...), the QUIC handshake (no answer, ALPN, certificate,
  TLS alert), HTTP/3 (SETTINGS without ENABLE_WEBTRANSPORT or H3_DATAGRAM,
  the CONNECT's status) and what the page reads, which stays Chrome's own
  "Opening handshake failed." for each, as natively. The transport's own
  session to the relay gets a line of its own (discovery, each handshake
  with the browser's WebTransportError, the Wisp stream), from the carrier
  host too, told only to realms in the verbose mode; the carrier host says
  when it holds a stream the relay throttled (0x49). The lines carry
  origins, counts, times and codes, never a path, query or header value,
  and are bounded (240 characters a step, 2000 a line, 32 traces a minute).
  Off by default. `webtransport-trace` forces each stage against local
  fixtures (the WebTransport fixture server gained `alpn` and `settings`,
  the wisp gate per-name close reasons); docs/webtransport.md, "Tracing a
  session", has the reading and a recipe for collecting one trace.
