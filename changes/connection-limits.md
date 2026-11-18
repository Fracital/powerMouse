### Fidelity

- A proxied page's requests reach a server as Chrome's do: at most six in
  flight to an HTTP/1 server per host and port (in a network partition,
  with credentials or without), 256 in all, the rest waiting for a
  connection the most urgent first (a document, a stylesheet or a fetch
  before images), and an HTTP/2 or HTTP/3 server gets them all on its one
  connection. Epoxy opened a connection per request in flight: 100 at once
  to an HTTP/1 server opened 100 connections, where Chrome opens 6.
  WebSockets go one handshake at a time to a host and port, and past 255
  sockets a new one fails, as in Chrome (connection-limits suite, against
  Chrome 157; our epoxy build says which HTTP version each response came
  over, deploy/epoxy patches epoxy-tls 0063 and epoxy-transport 0055).

### Known limitations

- A script a page inserts waits as one of its markup and a beacon as a
  fetch, and an image in the viewport is not raised once laid out, so the
  order requests wait in can differ from Chrome's; the limits are each
  controller's rather than the browser's.
