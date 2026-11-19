### Performance

- A document whose head is megabytes reaches the page in about half the
  time. The service worker looked for `<body` in the whole head after each
  piece of it, and the client looked for a record's length in the whole
  record after each chunk, each a copy of a text that grows: quadratic over
  CNN's 3.7 MB head (0.4 s in the worker, 0.6 s in the page). Each now looks
  at what is new. First paint, cold, Chrome 157: CNN 2.9 s to 1.5 s
  (natively 0.6 s), a local page with a 3 MB head style 1.4 s to 0.8 s.
  (html-stream suite: a 1.5 MB head reads and applies as natively.)
