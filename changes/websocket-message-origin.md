### Fixes

- A message of a proxied WebSocket names the socket's origin in
  `event.origin` (`ws://host:port`), as natively; it read the socket's
  whole URL, path and query included. (wpt-websockets:
  opening-handshake/003.)
