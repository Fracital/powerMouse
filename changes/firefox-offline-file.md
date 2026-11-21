### Demo and API

- offline.html boots from file: in Firefox and loads a page, where a file:
  page's origin, and a file: URL's, is the opaque `null` (Chrome's is
  `file://`): the page made its emulated worker's location and every route
  on that origin, and the worker threw on `null/stomp/serviceWorker.js`.
  A file: page whose origin is `null` now makes them on `file://`, and its
  worker reads that as a file: URL's origin, as in Chrome. (npm run
  test:firefox.)
