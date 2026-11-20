### Build

- The bytes of a `data:` URL a script or stylesheet names with integrity
  metadata (`dataURLBytes`, now in `src/sriDigest.ts` with
  `dataIntegrity`) are decoded in the deferred part that checks them
  against the metadata, made at a document's first such check, and no
  longer in the document bundle. Without the part the browser is given an
  empty `data:` URL to check, which fails, as before.
