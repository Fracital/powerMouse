### Fidelity

- A proxied WebSocket sends nothing once the page has called close(), and
  dispatches no message that arrives while it closes, as natively: a send
  after close() went out ahead of the close frame, and a server's echo of
  it reached the page (web-platform-tests' send/007.html passed or failed
  by the run). bufferedAmount counts what the page sent that the transport
  has not taken yet, and everything sent after close(), where it read 0
  (bufferedAmount-getting, -large, -unicode and -unchanged-by-sync-xhr, and
  the six Send-\* tests that read it, in a window and in a worker, pass
  now). An ArrayBuffer the page sends stays its own: the transport took it
  over to its worker, and the page's buffer read 0 bytes after the send
  (websocket-close).
