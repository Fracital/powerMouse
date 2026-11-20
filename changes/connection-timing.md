### Fidelity

- A page's navigation and resource timing has the transport's real
  connection times and the bytes a compressed body really came as. Every
  answer read as one made on no connection, at the fetch's start:
  `secureConnectionStart` 0 for https, `connectStart` equal to
  `connectEnd` on a fresh connection, and the encoded size of a body
  without a Content-Length equal to its decoded size (example.com's
  document: 577 and 577, natively 334 and 577). Now a fresh connection
  has its lookup (the HTTPS record's, when a request waited for one), its
  connect, its TLS start and end, in order, from where the page's fetch
  started; a connection that had carried a request before has them all at
  the fetch's start, `secureConnectionStart` too, as Chrome reports them;
  the time a request waited for a connection (Chrome's six to an HTTP/1
  server) comes before its connection's steps; and a compressed body the
  worker reads before it answers (a document, a script, a style sheet)
  has the bytes the transport counted before it decoded it, with
  `transferSize` those and 300. The transport says these (our epoxy
  build: deploy/epoxy patches epoxy-tls 0078 and epoxy-transport 0056;
  stomp-h3 counts its bodies too, and Http3Transport times its QUIC
  connections), the worker marks them (`stomp-connection`, `stomp-size`)
  and the inject shows them. A body the worker passes on as it comes (an
  image, a fetch of data) still counts as the bytes the browser was given
  when it came compressed without a Content-Length. (connection-timing
  suite.)

### Performance

- A reload asks the DoH server nothing for a name whose HTTPS record the
  host's ECH store kept: the store keeps the record's answer as well, which
  HTTP/3 reads its h3 from (`echCache.ts`, epoxy-transport 0061).
