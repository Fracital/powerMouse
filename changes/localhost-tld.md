### Fixes

- Names under the localhost TLD load through the proxy, as they do in Chrome.
  www.localhost and c.localhost were "Could not reach the site": the relay
  resolves with musl, which does not treat that suffix as loopback, so the
  name never resolved. A connection to such a name is opened to 127.0.0.1,
  and the request's Host stays the name. A relay that refuses loopback still
  refuses the address. (sop-partitions, sop-escapes, site-pool-sop,
  net-partitions, frame-own-requests, frame-replace-xhr, top-navigation.)
