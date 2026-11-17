### Fixes

- A `Request`'s referrer is the page's. `new Request(url, { referrer })`
  resolved the referrer against the proxy's URL: a relative one read back as
  a proxy URL (`http://<proxy>/foo`), one of the page's own origin as
  `about:client`, and a fetch of such a request went out with the default
  Referer. The referrer now goes to the browser as its route and reads back
  as the page's URL; `fetch()` rejects with the browser's TypeError for a
  referrer that is no URL and for a URL with credentials, which went out
  before. (wpt-fetch-basic, wpt-fetch-objects, wpt-fetch-abort suites.)
