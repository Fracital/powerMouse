### Fixes

- `new EventSource(url, { withCredentials: true })` is a request with
  credentials again. The constructor hook passed the routed URL on and
  dropped the page's init, so `withCredentials` read false and a stream of
  another origin got no cookies and set none: a site whose event stream
  lives on another host of its own (an API host, a push host) connected
  signed out. (wpt-eventsource: the cross-origin reconnection case, and the
  credentials cases as far as the first cookie.)
