### Fixes

- A `no-cors` fetch of another origin with `redirect: 'manual'` or `'error'`
  is a network error, as natively; the browser, to which the route is its own
  origin, let it through. (wpt-fetch-credentials-redirect suite.)
