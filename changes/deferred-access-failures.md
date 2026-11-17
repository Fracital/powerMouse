### Build

- The wording of the access API's errors (a call of no function, a `new`
  of no constructor, a value not iterable, a destructuring of null, named
  by the page's expression as V8 names it) is a deferred part of the
  document bundle (`src/inject/accessFailures.ts`), made at a document's
  first such error; the worker bundle keeps it. Without the part the
  error the operation threw is thrown (deferred-refusals).
