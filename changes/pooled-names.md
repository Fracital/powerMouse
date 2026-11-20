### Build

- The document bundles read `.prototype` through a variable of their own
  (`a[v]` for `a.prototype`, build.js `poolNames`, after esbuild): the
  minified `injectDocument.js` wrote it some 1,040 times, nearly all where
  hooks are installed as a frame starts. The read is the same read, and the
  source maps move with the text. `injectDocument.js` is 6,054 bytes
  smaller (475,277 to 469,223). (frame-cost.)
