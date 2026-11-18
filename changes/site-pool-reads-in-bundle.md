### Performance

- With the site pool, a frame of another slot that reads its `parent` or
  `top` or posts to its parent (an ad frame does as it starts) evaluates no
  deferred part for it: the stand-in of and the post to a window of another
  slot (`restrictAcross` and `postAcross`) are in the document bundle again,
  about 3 KB of heap a frame less (frame-cost's frames that read their
  parent, site-pool-refusals).
