### Performance

- A proxied document no longer asks the service worker which client it is.
  The worker that served its navigation knows (the navigation's resulting
  client id), and the document's shell now says so. Asking cost a request
  and a pass of the worker's router for every document and frame. It also
  cost the frame's Navigate hooks 0.31 ms, where they now take 0.05 (mean
  of 90 ad-like frames, Chrome 157). A document that a worker of an earlier
  build served still asks.
