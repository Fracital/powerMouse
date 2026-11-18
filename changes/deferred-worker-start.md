### Build

- What a Worker or SharedWorker construction does once the page's script
  passed its checks (a blob: worker's bootstrap, a data: worker's rewrite,
  the worker's first listeners: `src/inject/workerStart.ts`) is a deferred
  part of the document bundle, made at a document's first worker; the
  worker bundle keeps it. Without the part the constructor throws before
  the browser's is called (deferred-refusals).
