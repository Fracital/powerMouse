### Fixes

- `new SharedWorker(url, null)` names the worker "", as natively (null is
  the empty options dictionary), not "null" (`src/inject/modules/Worker.ts`).
  (wpt-workers-constructors.)
- A function whose prototype chain has another function before
  Function.prototype (a class's parent, or one given with
  `Object.setPrototypeOf`) with a static `toString` of the page's prints
  its own source through `Function.prototype.toString`, as natively: the
  hook that answers a function with its own realm's toString took the first
  toString on the chain, so the page's was called and its answer returned;
  it now takes the realm's Function.prototype, the last function on the
  chain (`src/inject/modules/Proxy.ts`). (function-strings, natively
  against both modes.)
