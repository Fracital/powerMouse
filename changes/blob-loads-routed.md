### Fixes

- A document, a script, a stylesheet or a worker the page loads from a
  blob: URL is rewritten whatever made the Blob: a slice, a Blob of Blobs, a
  Response's or a structured clone's Blob, an untyped one, one a worker made.
  The inject rewrote only the Blobs its constructor saw holding HTML or a
  JavaScript type, and everything else ran raw, reading the proxy's address
  and reaching other sites past the proxy. The load is routed instead: a
  document becomes an inline document the service worker reads from the
  Blob, and a script or stylesheet a route the worker reads and rewrites
  (from a private URL of the Blob, so a revoke right after the load starts
  stops nothing, as natively). A Blob now holds the page's own bytes
  (`size`, `text()`, `arrayBuffer()` read what the page put in it, where an
  HTML or script Blob read the proxy's rewrite). (blob-unseen, blobdoc,
  adversarial-local suites.)
- Another site's blob: URL in the browser's form (every proxied site's
  Blobs are minted at the proxy's origin) loads nothing, as another origin's
  blob: URL natively does: a page that named one read the other site's Blob.
  (blob-unseen suite.)
