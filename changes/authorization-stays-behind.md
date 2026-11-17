### Fixes

- An `Authorization` header a page set stays behind when a redirect leaves
  the origin it was sent to, as in Chrome. The browser follows a redirect in
  proxy URL space, where no hop is another origin, so it sent the header on
  every hop: the next origin got the page's credentials, and a preflight
  asked leave for a header the browser would not send (a redirect to a
  signed URL on a storage host fails on both).
  (wpt-fetch-credentials-redirect suite.)
