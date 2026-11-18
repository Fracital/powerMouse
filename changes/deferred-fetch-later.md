### Build

- fetchLater's call (`src/inject/dom/fetchLater.ts`) is a deferred part of
  the document bundle, made at a document's first call; its hook moved
  from the Fetch module, which the worker bundle shares, to the Navigator
  module, since only a window has fetchLater. Without the part the call
  throws before the browser's fetchLater is called (deferred-refusals).
