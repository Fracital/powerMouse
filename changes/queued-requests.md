### Fidelity

- An image a page has laid out in its viewport while it loads is raised
  to a fetch's urgency in the transport's queue, as Chrome raises it, so
  on an HTTP/1 server a fetch, an XHR or a script that comes while the
  visible images wait goes after them. The page watches its images only
  once the service worker says one of them waits for a connection (a
  deferred part of the inject), so a frame whose images never wait pays
  nothing for it.
- A document's first five images go at a script's urgency, as in Chrome
  before it has laid them out: Priority `u=2, i` over HTTP/2 and HTTP/3,
  and their place in the line for a connection to an HTTP/1 server.
- A request the page aborts while it waits for a connection leaves the
  queue and never reaches the server, as in Chrome; it used to go out
  anyway (connection-limits suite, against Chrome 157).
