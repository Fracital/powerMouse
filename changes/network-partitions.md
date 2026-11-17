### Origin isolation

- A proxied site no longer reuses the connections another site opened: the
  service worker names each request's network partition (the top-level
  site, apart for a context cross-site to it), and our epoxy build keeps a
  connection pool and TLS session caches per partition over the one wisp
  connection (deploy/epoxy patches epoxy-tls 0062, epoxy-transport 0054),
  as Chrome keys its socket pool, so a page cannot time whether another
  site warmed a connection to a third. HTTP/3's alt-svc knowledge and QUIC
  connections are kept per partition too. No wisp WebSocket is added
  (net-partitions suite, against native Chrome 157).

### Known limitations

- A request without credentials still shares the connections of those with
  credentials within a partition (Chrome keeps them apart), and a transport
  other than our epoxy build keeps one pool for every site.
