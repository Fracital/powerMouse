### Fixes

- A blob: worker (classic or module) starts, and a blob: script or
  stylesheet loads, in a frame of another site's page in Firefox and Safari
  (WebKit) too. The service worker reads the page's Blob to rewrite it, and
  there those browsers refuse its read of a blob: URL the frame minted: the
  worker failed to start. The frame now hands the service worker the Blob's
  bytes with the load, until the worker says it reads them itself.
