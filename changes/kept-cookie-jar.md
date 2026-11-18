### Performance

- The service worker keeps each domain's cookies as the jar last read them
  until a write, instead of asking IndexedDB once for every candidate
  domain before each request with credentials (four reads in a row for
  img.cdn.example.com, about a millisecond on the request's way out and
  tens of milliseconds while a page loads hundreds of resources). A read
  that a write overlaps is not kept; the site pool's jar server and any
  other worker of the origin say on a BroadcastChannel when they wrote,
  and with the site pool on nothing is kept. jar-kept checks every way the
  jar is written against the next request, natively and proxied.
