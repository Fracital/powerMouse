### Fixes

- A request to a port on the fetch standard's blocked list (25, 6667, ...) is
  a network error at once, as the browser's; the transport tried to connect.
  (wpt-fetch-objects suite.)
