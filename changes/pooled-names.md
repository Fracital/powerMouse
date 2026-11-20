### Build

- The document bundles read `.prototype` through a variable of their own
  (`a[v]` for `a.prototype`, build.js `poolNames`, after esbuild): the
  minified `injectDocument.js` wrote it some 1,040 times, nearly all where
  hooks are installed as a frame starts. So do 13 more names it reads as it
  installs its hooks or as its listeners take events (`addEventListener`,
  `addModule`, `removeAttribute`, `stopImmediatePropagation`, `Document`,
  `querySelectorAll`, `Element`, `HTMLFormElement`, `postMessage`,
  `DOMException`, `HTMLScriptElement`, `dispatchEvent`, `EventTarget`). The
  read is the same read, and the source maps move with the text.
  `injectDocument.js` is 10,292 bytes smaller (475,277 to 464,985).
  (frame-cost.)
