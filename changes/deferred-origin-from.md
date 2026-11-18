### Build

- What `Origin.from()` answers a proxied page (`src/inject/originFrom.ts`:
  a window's, a link's, a message's and the page's own global's emulated
  origin) is a deferred part of the document bundle, made at a realm's
  first call; the hook stays, and the worker bundle has the part itself.
  Without the part the call throws before the browser's `Origin.from` is
  called (deferred-refusals).
