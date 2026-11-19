### Transport

- A proxied page shown again from the back/forward cache goes on to its
  next page as natively. Chrome closes a page's WebSockets as it goes into
  the cache, the transport's wisp WebSocket with them, and epoxy's own
  WebSocket (a transport without `webTransport`) never ended its wisp
  connection on that close: the first request after Back went to the site's
  pooled connection over it and was never answered, so a link in the demo's
  frame did nothing for good after Back to the demo. The controller now
  tells the transport when its page is back, and the next request or socket
  goes over a new wisp connection (200 ms after Back, natively 198 ms).
  (bfcache-transport suite.)
