### Performance

- A document whose body comes right behind a large head paints sooner: the
  page gets the head's rewritten inline scripts as soon as they are done.
  The service worker read a body that arrived all at once in one stretch of
  microtasks, and the rewrite workers' answers for the head waited behind
  it: CNN's head scripts were rewritten 7 ms after they were sent, but the
  worker took their answers 160 ms later. It was also slow work. The worker
  looked for an unfinished script's end tag in all of the markup it held,
  once per chunk, which is quadratic (70 ms over CNN's 2.46 MB body
  script). It also copied, hashed and compared that script and its 7.9 MB
  rewrite on its own thread. Now the worker lets its other tasks run every
  5 ms, looks for the end tag only in the new text, holds a cut (50 ms at
  most) while the page still has records to take, and yields before each
  record. The rewrite workers write each inline script's preamble and pack
  its rewrite for the table themselves. CNN, Chrome 157: the head's record
  reaches the page at 0.3 s instead of 0.52 s, and the median first
  paint of a reload goes from 0.8 s to 0.71 s (0.36 s natively).
  (html-stream suite: a head script whose end tag comes in two pieces
  reads as natively.)
