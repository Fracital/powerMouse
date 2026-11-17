### Fixes

- `location.reload()` in a document a `javascript:` URL made loads the page
  at the document's URL again, as natively, where the frame showed STomp's
  "Page unavailable" error: the proxy serves such a document once, from an
  inline route, and the reload asked for that route again.
  (wpt-location suite.)
