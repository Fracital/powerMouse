### Fixes

- A CORS request that was redirected from another origin back to the page's
  own (or on to a third) sends `Origin: null`, as the browser's does once the
  chain is tainted; it sent no Origin header at all when the last hop was the
  page's own origin. (wpt-fetch-cors, wpt-fetch-credentials-redirect suites.)
