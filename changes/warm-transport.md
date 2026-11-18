### Performance

- The transport worker loads epoxy and opens its wisp connection as soon as
  the transport is made, not on the first request: the first navigation no
  longer waits for epoxy's wasm module and the WebSocket handshake to the
  wisp server before its request goes out. A cold first load's first byte
  came 16 ms sooner on loopback (36 to 20 ms) and 950 ms sooner over a
  40 ms, 20 Mbit/s link (970 to 24 ms), its first paint 24 ms and 950 ms
  sooner. A request made meanwhile waits for the connection, and one that
  cannot be opened is left to the first request, as before.
  (transport-init.)
