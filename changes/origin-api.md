### Origin isolation

- `Origin.from()` answers with the page's own origins. It read the internal
  origin of a platform object, which under the proxy is the proxy's for every
  site, so a message from another site compared same-origin with the page,
  `Origin.from(self)` was not the page's own origin (in a worker too), a link
  or area extracted its route's origin and a frame sandboxed to an opaque
  origin extracted a tuple one. The page's global, a window of its origin, a
  link or area (by the URL the page wrote) and a window message (by its
  sender's origin, opaque for "null") now give the origins Chrome gives
  natively, and what Chrome refuses (a synthetic event, a Location, another
  site's window) is refused in its words. `origin-api` compares every case
  natively and proxied; `adversarial-origin-api` covers the escapes.
