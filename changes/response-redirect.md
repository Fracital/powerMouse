### Fixes

- `Response.redirect(url)` resolves a relative URL against the page's, not
  the proxy's: its Location header named the proxy's origin.
  (wpt-fetch-objects suite.)
