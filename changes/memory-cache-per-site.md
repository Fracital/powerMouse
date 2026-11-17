### Performance

- The documents of one site share the images, fonts and other resources the
  renderer's memory cache keeps, as natively, instead of each holding its
  own copy. Every proxied site is in one renderer, so the service worker
  used to hand each such resource out as `no-cache` to keep one site's copy
  from another site's documents, and the renderer kept a copy per document:
  about 4 MB of a proxied ad frame's 7 (natively about 2 MB all in), which
  is a large part of why ad-heavy pages ran Chrome out of memory. The route
  of such a load now carries a mark of its document's site
  (`binary;m=<mark>/...`), drawn by the worker from a secret of its own and
  given to each document in its shell, and the worker hands the load out
  with the origin's caching headers when the mark is the asking document's
  site's: the renderer keeps one copy per site and gives it to that site's
  next document only. Scripts and stylesheets are rewritten and stay
  `no-cache`. An ad frame of three images and a web font, 30 frames in one
  renderer: 5.0 MB of RSS a frame before, 2.9 MB now, natively 2.7 MB.
  (memory-cache-share suite.)

### Fidelity

- A frame sandboxed without allow-same-origin, or a data: document, no
  longer gets the images and fonts its site's documents loaded from the
  service worker's caches: natively its renderer and its HTTP cache are its
  own, and it waits for the network. A load the renderer's memory cache
  answers reads in resource timing as natively (no bytes transferred,
  delivery "cache"). (memory-cache-share suite.)
