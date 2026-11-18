### Performance

- An HTTP/3 response reads about as fast as an HTTP/2 one: stomp-h3 runs
  in a worker of its own (src/transport/http3/h3Thread.ts), started by
  the transport worker from its own script, which keeps the wisp UDP
  streams and hands each datagram across as it arrives. A QUIC packet
  carries 1.2 KB, and its decryption, quinn's bookkeeping and the
  decoder queued behind every other request of the page. ACKs are
  decimated as Chrome's (quinn-proto 0003), ring's AES works in 64-bit
  words on wasm32 (ring 0001, vendored for stomp-h3), and ring and the
  decoders are built for speed. A 3 MB brotli web.js through the
  transport worker over HTTP/3 took 470 ms locally and takes 186 (HTTP/2
  147, Chrome 63); Discord's web.js took 577 ms and takes 263 (Chrome
  247). Where the worker cannot start, stomp-h3 runs in the transport
  worker as before. (http3, http3-fallback, demo-http3.)
- Epoxy takes a write of a Uint8Array or ArrayBuffer as it is (epoxy-tls
  0074): each socket write, datagram and streamed request body chunk went
  through a Request and a promise first.
