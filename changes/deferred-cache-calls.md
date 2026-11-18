### Build

- What a page's Cache API `add()`, `addAll()` and `caches.match()` do past
  their hooks' checks (`src/inject/cacheCalls.ts`: the fetch through the
  proxy and the put, the walk of the origin's own caches) is a deferred
  part of the document bundle, made at a realm's first such call; the
  hooks stay, and the worker bundle has the part itself. Without the part
  each call rejects before the browser's caches are asked
  (deferred-refusals).
