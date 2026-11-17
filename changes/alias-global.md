### Build

- A module's hook installer (its `apply()`, and a few other methods)
  reads `this.client.global` once, at its top, where each of its uses read
  the property chain again (esbuild keeps a property chain as written):
  `injectDocument.js` is 6.7 KB smaller (507.4 to 500.7 KB). (frame-cost.)
