### Fixes

- A CORS request is not redirected to a URL with credentials
  (`https://user:pass@host/`) unless the whole chain is the page's own
  origin: a network error, as the browser's. (wpt-fetch-cors suite.)
