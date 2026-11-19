### Fixes

- A response that ends as its server closes the connection (HTTP/1 with
  `Connection: close`) arrives whole through the carrier host's riders and
  a transport's shard lanes again. A message there carries several Wisp
  packets, and a download's last DATA and its CLOSE reached epoxy in one
  go, whose multiplexor drops what a stream holds unread once its CLOSE is
  in: the body ended short ("Failed to fetch"; legacy-tls's 300 KB
  downloads, two or three of six). A stream's CLOSE after its DATA in the
  same message now reaches epoxy a task later, as a packet of its own
  message did.
