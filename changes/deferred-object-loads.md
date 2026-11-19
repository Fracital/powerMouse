### Build

- The loads of an `<object>`'s data and an `<embed>`'s src, which the inject
  copies through the proxy (`src/inject/dom/objectLoads.ts`: the copy, its
  shell, the held context and type, the image an object shows by its URL),
  are a deferred part of the document bundle, made at a document's first
  object or embed with a URL; the hooks and the natives they read stay.
  Without the part an object fires error and shows no document, and an
  embed loads nothing, as for a failed fetch (deferred-refusals).
