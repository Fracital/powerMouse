### Fixes

- A proxied page loads in Firefox when the realm it gets has no request
  streams. Firefox 160 makes a fresh profile's first page natively, and
  often the first proxied document of a tab, with a Request that has
  neither `body` nor `duplex`, and the document bundle read the `body`
  getter as it loaded: the bundle threw, and the page showed "Stomp bundle
  did not load". The getter is now optional, and a fetch
  hands on a no-cors or keepalive Request as it is where there is none,
  since such a realm makes no request body a stream.
