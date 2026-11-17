### Fixes

- A message of an `EventSource` names the stream's real origin in
  `event.origin`, in pages and workers. It read the proxy's origin, the one
  every routed stream has for the browser: a page that checks where a
  message came from (as it would for `postMessage`) dropped every event,
  and the proxy's address was there to read. After a redirect to another
  origin the page still reads the first URL's origin, where Chrome names
  the last one's. (wpt-eventsource: the three cross-origin cases.)
