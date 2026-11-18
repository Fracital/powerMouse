### Transport

- epoxy over a function transport (a `wisp` that hands it a ReadableStream
  and a WritableStream of Wisp packets) no longer hangs every request on the
  connection once a TLS handshake runs beside another request: its writes
  never wait, as the WebSocket's `send` does not (deploy/epoxy epoxy-tls
  0075). No STomp path handed epoxy one before the WebTransport carrier;
  `epoxy-function-transport` covers it.
