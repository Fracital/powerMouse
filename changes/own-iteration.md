### Fidelity

- A page that replaces the natives of the iteration protocol
  (`Array.prototype[Symbol.iterator]`, `%ArrayIteratorPrototype%.next`, the
  String, Map and Set iterators, `%IteratorPrototype%[Symbol.iterator]`),
  as a polyfill does, no longer has its functions called by the inject, nor
  sees them steer what it does. Every `for...of`, spread, array
  destructuring, `yield*` and iterable argument (`Array.from`,
  `Promise.all`, the `Map` and `Set` constructors) of the inject bundles,
  their deferred parts, the light rewriter library and the WebRTC library
  is handed at build time to `ownIterable` (`src/ownIterable.ts`,
  `scripts/ownIteration.mjs`), which steps the native kinds by the natives
  taken before any page script ran, a Map or Set of another frame's realm
  too. The light library and the WebRTC library hand their names out
  without esbuild's export copy (a `for...of` that ran when a sandboxed
  frame evaluated its own copy), and the WebIDL sequences of the WebRTC
  and WebTransport stand-ins step an array natively, as Chrome does (it
  calls none of these natives). Measured natively on Chrome 157: the page's
  replacements count only its own loops. (access-tamper, as a top, in a
  same-origin frame and in a sandboxed one, in both modes;
  adversarial-scripts, whose hostile child page's iterator spoil is the
  full one again; frame-cost: `injectDocument.js` 498,076 to 501,348
  bytes.)
