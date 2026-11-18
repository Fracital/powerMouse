### Build

- The usage walk behind `navigator.storage.estimate()`
  (`src/inject/storageUsage.ts`) is a deferred part of the document bundle,
  made at a realm's first estimate; the worker bundle keeps it. Without
  the part the promise rejects before the browser is asked
  (deferred-refusals).
