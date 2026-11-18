### Build

- What a tainted source's refusals say (a WebGL texture, a VideoFrame, an
  OffscreenCanvas's `convertToBlob()`, with the probe of Chrome's wording)
  (`src/inject/dom/taintRefusals.ts`) is a deferred part of the document
  bundle, made at a document's first such refusal; the hooks, the taint
  checks and the walk of a message for a tainted ImageBitmap stay. Without
  the part each still refuses, with the part's error in place of Chrome's
  (deferred-refusals).
