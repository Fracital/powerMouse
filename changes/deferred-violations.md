### Build

- The securitypolicyviolation events the inject fires for the page's own
  policy, the Trusted Types refusals of a `createPolicy` and the errors
  Chrome throws at a refused sink, eval or WebAssembly compile are a
  deferred part of the document bundle (`src/inject/dom/violations.ts`),
  made only when the page's policy refuses something; an event's part is
  made in the timer that fires it. What is refused stays refused without
  the part; no event fires then, and the error thrown is the part's.
