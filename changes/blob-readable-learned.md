### Fixes

- In Chrome a worker's import() of a blob: URL it revoked fails at once
  through the proxy, as natively, also as the first load of a Blob after
  the service worker started. It waited 3 s: the service worker asked the
  worker for the bytes, which a Chrome worker cannot hear, before it had
  learned that it reads blob: URLs itself. It now learns that first, from
  one the proxy's controller mints for it.
