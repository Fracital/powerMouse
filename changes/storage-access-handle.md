### Security

- A StorageAccessHandle (`document.requestStorageAccess({ ... })` in a
  frame) hands out the site's first-party storage, as natively, never the
  browser's unpartitioned stores of the proxy origin: its localStorage and
  sessionStorage are the site's own stores under its first-party key, its
  indexedDB, caches and locks work on the window's stores under that key,
  getDirectory() is the site's own directory of the origin private file
  system and estimate() its usage, createObjectURL and revokeObjectURL are
  the page's (a blob: URL of its own origin), and BroadcastChannel and
  SharedWorker are the routed, scoped constructors made under the
  first-party key. The handle read and wrote STomp's own stamps and every
  site's keys, listed every site's directory, summed every site's usage,
  joined any site's channel by name and started a blob: shared worker with
  no inject. A proxied top-level page's request resolves with nothing, as a
  top-level page's does natively (`src/inject/dom/storageAccess.ts`, a
  deferred part, `src/inject/storageRedirect.ts`). (storage-access-handle,
  natively with storage partitioning on against both modes; the
  adversarial-storage gate.)
