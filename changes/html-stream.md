### Performance

- An HTML document reaches the page as it arrives, where the service worker
  read the whole body before the page got any of it: a 5 MB page trickled in
  at 8 MB/s showed nothing for 2 s, a 20 MB one for 7.5 s, natively 0.05 s.
  The worker reads until the encoding is decided (the first 1024 bytes) and
  the head has ended (`<body`), and then serves the shell. A document whose
  body comes at once, up to 256 KB, is served whole as before. The rest goes to
  the client as the origin sends it, through a route of the worker's
  (`markup-<token>`, read once). It is cut between whole tokens, each piece
  with its prewritten inline scripts and styles and the client hints its
  metas name. A script that ends a piece runs before the rest arrives, as
  natively. A body the network cuts short is the page as far as it came. A
  document of an opaque origin (a frame sandboxed without
  allow-same-origin) reads its markup too. The navigation's
  `encodedBodySize`, `decodedBodySize` and `transferSize` are the
  document's, not the shell's. (html-stream suite.)
