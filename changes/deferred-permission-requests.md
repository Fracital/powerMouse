### Build

- The Permissions module's requests (what asks the worker and the host
  for a permission, and whether a request reaches the browser's own
  call) are a deferred part of the document bundle, in the group of the
  calls that make them (`src/inject/dom/modules/permissionCalls.ts`).
  Without the part a request rejects before the browser is asked.
