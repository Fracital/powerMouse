### Fidelity

- `Reflect.construct(Function, args, newTarget)` (and the generator and
  async constructors) with a newTarget of another realm whose `prototype`
  is no object makes the function with that realm's intrinsic prototype, as
  natively: it had this realm's. Found by test262
  (`built-ins/*Function/proto-from-ctor-realm-prototype.js`).
