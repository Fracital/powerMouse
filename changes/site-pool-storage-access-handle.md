### Origin isolation

- With the site pool on, `document.requestStorageAccess({ ... })` in a
  frame of another site resolves its StorageAccessHandle again. The hook
  took a frame of another slot, which reaches no proxied parent, for a
  top-level document and resolved with nothing.
