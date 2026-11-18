### Fidelity

- A request whose kept-alive connection the server closed as the request
  reached it goes again on another connection, as Chrome 157 sends it: when
  the connection was a kept one and ended before any byte of a response,
  whatever the method (a POST's body goes again), on each kept connection
  and then a fresh one; after a 408 on a kept HTTP/1 connection; and for a
  stream an HTTP/2 server refused, twice at most. Through the proxy a POST,
  PUT or DELETE the server's idle timer caught failed, and the transport
  wrapper sent a GET again up to four times whatever came before the close,
  so a GET a fresh connection dropped reached the server five times (Chrome
  once) and one whose head had begun went again. Epoxy now decides, as
  Chrome does (deploy/epoxy patches hyper 0052, hyper-util-wasm 0052,
  epoxy-tls 0073), and the wrapper sends again only what a lost wisp
  connection took: a GET whose connection ended before its head asks the
  wisp connection for a stream, and goes again over a new one when that
  fails (idle-close-retry suite: 27 of 125 checks differed, none now;
  wisp-reconnect and reviving-transport). This replaces the known
  limitation that such a request fails.

### Known limitations

- A truncated response head over plain HTTP (a status line and fields, then
  the connection closes) fails the request through epoxy; Chrome takes it
  for a response with those fields and an empty body (over HTTPS it fails
  too).
