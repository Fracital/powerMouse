### Fidelity

- A proxied WebSocket's `bufferedAmount` counts a message until it has left,
  as natively: until epoxy wrote the frame within its wisp stream's
  CONTINUE credit (src/transport/socketSends.ts asks epoxy's socket for the
  promise epoxy-transport drops, and the transport worker tells the page,
  frame by frame, in order). It fell to 0 a moment after each `send()`
  whatever the server had read, so a speed test that counts
  `sent - bufferedAmount` measured the page's own speed. A page's close
  waits for what it sent before it, and `send()` converts what is neither
  a string nor binary to its string as the browser does (`null` goes as
  "null", a number as its digits; the socket stopped on such a send).
  `websocket-buffered` compares a burst to a server that reads nothing for
  3 s natively and proxied; five `wpt-websockets` pages pass now.
- A proxied `WebSocketStream`'s writes settle once their message has left,
  by the same measure, so `writer.ready` and `desiredSize` hold a writer
  back while the server reads nothing, as natively. Each write settled at
  once (`desiredSize` never fell), and a 48 MiB burst read as written
  before the server had read a byte (`websocket-buffered`).
- A proxied WebTransport stream's write settles once the session's
  datagrams have carried all but 256 KiB of what its streams were written,
  not once quinn took the bytes into its send buffer (up to the server's
  flow control and quinn's 15 MiB send window), so `writer.ready` and an
  upload counted by settled writes keep the path's pace
  (deploy/epoxy/h3/src/wt.rs `until_sent`, `webtransport-buffered`). The
  epoxy-transport STomp pins (EpoxyTransport dist be1a3b1) carries this
  stomp-h3.

### Fixes

- Messages a page sends on a proxied WebSocket reach the server in the
  order it sent them: a Blob was read on its way to epoxy while a string or
  ArrayBuffer sent after it went ahead (`websocket-buffered`).
