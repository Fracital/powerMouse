### Security

- A page that replaced `WeakMap.prototype.get` was called with the inject's
  table of every hooked function's native source by the first
  `Function.prototype.toString` of a hooked function, and could read the
  natives out of it (`fetch`'s, `append`'s). The table is asked through
  the natives taken as the bundle loads, as the window collections are
  (access-tamper).
