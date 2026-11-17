### Fixes

- `localStorage.setItem()` over the quota throws the browser's
  `QuotaExceededError` (with `quota` and `requested`), as natively, not a
  DOMException of that name (`src/inject/dom/modules/Storage.ts`).
  (storage-quota.)
