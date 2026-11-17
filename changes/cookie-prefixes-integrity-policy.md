### Fidelity

- Cookie names that start with `__Http-` or `__Host-Http-` are kept as
  Chrome keeps them: only from a response, only with `Secure` and
  `HttpOnly`, never from script. A `__Host-` cookie whose Domain is the
  IP address it was set from is kept, as natively. (cookie-prefixes suite.)
- `Integrity-Policy` blocks a document's scripts that have no integrity
  metadata or are not fetched in CORS or same-origin mode, as natively; the
  header reached the browser untranslated, where it blocked the proxy's own
  scripts and the page never ran. (integrity-policy suite.)
- `Set-Login`, `Activate-Storage-Access` and `Use-As-Dictionary` no longer
  reach the browser from a proxied response, where they would be applied to
  the proxy's origin for every site.
