### Fixes

- A preflight answer whose `Access-Control-Allow-Methods` or
  `Access-Control-Allow-Headers` has an item that is no token fails the
  preflight, as in Chrome; such an item was skipped. (wpt-fetch-cors suite.)
