### Fidelity

- A request whose answer is held for minutes is answered when it comes, as
  natively. Chrome puts no time limit on a request's headers, but STomp's
  service worker answered every routed request 504 after 60 s (120 s for
  documents and media): office.com's scripts behind a slow transport
  failed their integrity check and the page threw. The worker now puts no
  limit of its own on a routed request. An emulated service worker's
  `respondWith` now may take as long as Chrome lets a fetch event run, 5
  minutes, and past it the request is a network error as in Chrome, where
  it went to the network after 30 s. (long-held-requests suite.)
