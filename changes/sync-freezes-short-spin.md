### Fixes

- The controller's page no longer stops for 300 ms when the service worker
  first asks whether a waiting page stops its workers (WebKit's case,
  syncFreezes). The controller learned it by spinning its own thread for
  150 ms twice, and everything that thread runs waited: the host page's
  UI, and with the transport in the page every request it carries. In
  Chrome a request of a fresh profile's first page could take 150 or
  300 ms where it takes 1 ms (http3-fallback failed on that). The first
  round now spins 30 ms, and a call that lands while the page still waits
  decides it, as it does in Chrome and Firefox within a few ms. Only an
  engine where the call lands late (WebKit) goes on to the two 150 ms
  rounds, which must agree as before (sync-engines).
