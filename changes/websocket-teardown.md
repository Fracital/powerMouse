### Fixes

- A proxied page's WebSockets close when the page goes, as Chrome closes a
  document's sockets (1001) when it navigates away or its frame is
  removed. They stayed open, with their upstream connection, Wisp stream
  and shard socket, for as long as the server kept them, so a long session
  of news sites and live pages piled them up in the transport: no worker
  hears a document go (Chrome 157 fires no MessagePort close event). The
  document's transport closes its sockets with 1001 on its pagehide, and
  the transport worker closes a socket's channels once it closed, as the
  server sees natively (websocket-teardown).
