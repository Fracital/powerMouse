### Fixes

- A frame of a blob: document loads, and a blob: module's static import of
  another blob: module runs, in a frame of another site's page in Safari
  (WebKit) and Firefox too. The service worker could not read the page's
  Blob there: the blob: document's Blob was posted to it, which WebKit's
  worker cannot read, and an imported blob: URL it routed by its URL alone,
  which neither browser lets it fetch. The page now hands it a blob:
  document's bytes with the document, and the worker asks the page for an
  imported module's bytes when it cannot read them.
