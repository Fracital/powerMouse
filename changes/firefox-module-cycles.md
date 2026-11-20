### Fidelity

- An import cycle of module scripts runs in Firefox in a document no
  service worker controls (an about:blank frame, popup or written markup),
  as it did in Chrome and WebKit. The inject copies such a document's
  module graph to `blob:` URLs, which cannot name a module before it is
  made, and closed a cycle with an import map, which Firefox takes none of
  once a module of the document has loaded. Now the core module's linker
  (flag 2048, `rust/rwjs/src/link.rs`) merges a cycle's modules into one
  module, and each of them is copied as a module that exports what it did
  from that one, in every engine: each keeps its own top-level names
  (renamed by a scope walk where another module of the cycle declares or
  reads the name, a function's `name` kept), its own `import.meta`, live
  bindings, `export *`, the order the browser runs a cycle in, functions
  hoisted across it and the temporal dead zone. uncontrolled-modules has
  no known difference left, and adds a cycle of three modules that reads
  all of that. Still the merge's: a `*` import of a module of the cycle
  reads an object of getters, not the namespace `import()` answers, and
  the modules outside the cycle run before all of its own. A cycle the
  linker declines is closed by an import map as before.

### Performance

- The core module is 28,424 bytes larger (756,811; 260,123 brotli), for
  the linker. The
  document inject is 6 bytes larger; the glue and the cycle's handling
  (1,341 bytes) are in the document's rewriter library and its deferred
  parts, loaded at a document's first module graph. A worker's bundle is
  unchanged.
