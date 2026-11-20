### Fixes

- An about:blank that a page navigates the child of another origin's frame
  to is the page's in Chrome and Firefox, as natively: the page reaches it
  and the frame does not. Through the proxy the frame reached it and the
  page got a SecurityError. In Safari it stays the frame's, as natively.
- Under a frame of another site such a document is in its site's partition
  with a cross-site ancestor, as in Chrome: its `document.cookie` reads ""
  and its requests, its blob: workers' and its blob: documents' carry that
  partition's cookies, not the navigating page's. Its service worker
  `register` rejects with InvalidStateError.
