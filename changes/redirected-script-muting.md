### Fidelity

- A script of the page's own origin whose redirects went through another
  origin without CORS is muted as natively, however the page left its
  resource timing buffer: a document's error event and `onerror` read
  "Script error." with no file, position or error (they read the script's
  own error and its first URL), and a worker's `importScripts()` of one that
  ended at another origin throws its NetworkError even when the worker's
  buffer is full (it threw the script's own error, since the hook found the
  import's mark in the page-visible buffer). One whose chain came back to
  the worker's origin is not muted in a worker, as Chrome 157 does not mute
  it (it threw the NetworkError). The service worker marks the last hop of
  a chain that ended at another origin (`stomp-away`, beside
  `stomp-opaque`), and the inject reads both from observers of its own,
  made before the page runs. (error-surfaces: redirectedAway*,
  redirectedBack*, workerImportRedirected.)
