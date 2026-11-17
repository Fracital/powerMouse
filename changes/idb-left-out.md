### Build

- The inject bundles leave out idb, the service worker's IndexedDB wrapper:
  `src/server/Cookies.ts` imports it for its jar class, which no inject
  bundle uses, and its top level (three WeakMaps and its trap tables) ran
  in every proxied frame. `injectDocument.js` is 2.9 KB smaller and
  `injectWorker.js` 2.9 KB. (frame-cost.)
