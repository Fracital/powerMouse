### Transport

- HTTP/3 decodes deflate and zstd responses as well as gzip and br, and
  asks for `gzip, deflate, br, zstd` where the page's request has its
  Accept-Encoding, as Chrome does; a deflate or zstd answer reached the
  page undecoded. A Cookie goes out as one field per cookie, as Chrome's
  QPACK encoder sends it.
