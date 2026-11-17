### Security

- `navigator.webkitTemporaryStorage` and `webkitPersistentStorage`
  (`queryUsageAndQuota`, `requestQuota`) report the usage and quota
  `navigator.storage.estimate()` does, this site's partition's, as natively
  they report the origin's; they reported the proxy origin's, every
  proxied site's stores and STomp's caches together. The browser still
  checks the arguments and calls back (`src/inject/modules/StorageEstimate.ts`).
  (storage-deprecated-quota, natively against both modes; the
  adversarial-storage gate.)
