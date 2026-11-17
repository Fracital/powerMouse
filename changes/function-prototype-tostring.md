### Fixes

- `Function.prototype.toString.call(Function.prototype)` is
  "function () { [native code] }", as natively, not "[object Function]":
  the hook that answers a function with its own realm's toString took the
  first toString on the prototype chain, Object.prototype's for
  Function.prototype itself; it now takes the realm's Function.prototype,
  the last function on the chain (`src/inject/modules/Proxy.ts`).
  (wpt-workers-basics.)
