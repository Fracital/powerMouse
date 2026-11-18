### Fixes

- fetch, the Request constructor and fetchLater take a Request made by
  another window (an iframe's, the parent's) as the request it is. The
  fetch hook told requests apart with `instanceof`, which knows only its own
  window's prototype, and fetched the string "[object Request]" resolved
  against the page instead, with the request's method and body dropped:
  Subscribe with Google on washingtonpost.com asked for
  news.google.com/swg/[object Request], and any library that takes a clean
  fetch from an iframe and calls it with its own Requests broke the same
  way. A request is now recognised by the browser's own brand check.
  (fetch-cross-realm suite.)
