### Fixes

- `localStorage.key()` and `sessionStorage.key()` convert their index as
  an unsigned long, as natively: `key(2 ** 32)` is `key(0)` and `key(-1)`
  is null, not undefined (`src/inject/dom/modules/Storage.ts`).
  (wpt-webstorage.)
