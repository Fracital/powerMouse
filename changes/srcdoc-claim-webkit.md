### Fixes

- In Safari, a `fetch` from an about:srcdoc frame reads its own site as
  natively. Safari reports the frame's messages to the service worker as
  its parent's, so the proxy never learned whose the frame was, and every
  CORS read it made failed with a TypeError.
