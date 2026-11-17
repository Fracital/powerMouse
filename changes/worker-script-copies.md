### Performance

- The service worker makes fewer copies of a script it rewrites and keeps
  none of its own. It shares the renderer of the proxied frames in
  same-origin mode, and an idle worker never collects, so every copy it
  left stayed there until its next collection, and what it kept stayed for
  good. The rewrite cache's key joined the body to its other parts in one
  more buffer on every load, hit or miss; it is a digest of the parts and
  the body's own digest now. The rewritten text went out as UTF-8 bytes of
  the worker's own, which the same document's repeat of the request kept
  for 30 s and the page's Response and the cache's each copied again; the
  memory cache kept its entries as ArrayBuffers (up to 96 MB), copied again
  into every Response it answered with. Both are Blobs now, whose bytes the
  browser keeps. A 4 MB script leaves 8 MB of the worker's ArrayBuffers
  per load (it left 12 to 25.5 MB) and the worker keeps none of it (9.4 MB
  after a rewrite, 13.4 MB after a load the memory cache keeps). Ad frames
  that load a 190 KB script by URL leave about 100 KB per frame in the
  renderer's ArrayBuffer partition, where they left 250 KB. Every kept
  rewrite misses once after the update, under its new key.
  (worker-script-copies suite.)
