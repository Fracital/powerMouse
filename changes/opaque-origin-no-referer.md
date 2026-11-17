### Fixes

- A document sandboxed to an opaque origin sends no Referer with its fetch
  and XHR requests, as natively; it sent its parent's address.
  (frame-referrers suite.)
