### Fixes

- `q.cite`, `blockquote.cite`, `ins.cite` and `del.cite` read the page's
  URL, resolved against the page's base as natively: the property was not
  hooked, so the browser resolved the attribute against the document's
  real address and the page read a routed URL on the proxy's origin
  (wpt-base-urls suite).
