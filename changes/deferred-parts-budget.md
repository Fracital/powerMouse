### Build

- More of the document bundle is deferred parts, evaluated the first time
  a document needs one: the relay of a beacon a document no service worker
  controls sends (`src/inject/dom/beaconRelay.ts`), XMLHttpRequest's checks
  of open()'s method and setRequestHeader()'s header
  (`src/inject/xhrChecks.ts`, at a document's first such call; the worker
  bundle keeps them), `location.ancestorOrigins`'s list
  (`src/inject/dom/ancestorOriginsList.ts`), NamedNodeMap's methods called
  on an element's `attributes` (`src/inject/dom/attributeViewMethods.ts`),
  the referrer policy of a navigation in a fresh browsing context
  (`src/inject/dom/sourcePolicy.ts`) and the sizing of an IndexedDB record
  for `navigator.storage.estimate()` (`src/inject/idbSize.ts`; the worker
  bundle keeps it). `injectDocument.js` is 5.6 KB smaller (491.5 to
  485.9 KB). (frame-cost, deferred-parts and the suites of each part.)
