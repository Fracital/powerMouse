### CI

- early-errors holds Chrome 158 to its own verdicts on a call used as an
  assignment target (`a() = 1`, `a()++`, `for (a() in b)`, `super() = 1`
  in a class): Chrome 158 refuses it at compile time in strict code, a
  module and a class body, where Chrome 157 and older threw a
  ReferenceError when it ran (rust/host/early-lib.mjs `CHROME_CHANGED`,
  since 158). The proxy already answered them as natively.
- epoxy-simd-fallback first checks that the installed epoxy-transport is
  the build package-lock.json pins (node_modules/.package-lock.json), so an
  install older than the lock fails with both commits named, not with a
  wasm magic word in twelve checks.
