### Build

- What `performance.measureUserAgentSpecificMemory()` answers a proxied
  page with under an isolated host (the browser's result with the page's
  own URLs and its frames' `src`, `src/inject/dom/measuredMemory.ts`) is a
  deferred part of the document bundle, made at a page's first call;
  without it the promise rejects before the browser measures.
