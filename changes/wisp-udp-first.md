### Transport

- A relay never met before rides its WebTransport session from the first
  start whenever the session is up within 3 s (one and a half
  `timeoutMs`) of the start, however long after the WebSocket that is; the
  WebSocket, opened beside it, is ridden only when the session fails (at
  once) or is not up by then. Before, the first start took the session only
  when it was up within 50 to 100 ms of the WebSocket, so on
  https://stomp.fracit.al/ (the session up in about 1.2 s, the WebSocket in
  0.5) every fresh browser's first start rode TCP. A network that drops UDP
  now waits out the handshake's `timeoutMs` (2 s) once per relay, then
  rides the WebSocket at once as before. `webtransport-wisp` and
  `demo-carrier` cover a session up well after the WebSocket.
