### Performance

- A reload and a new tab no longer ask the DoH server again for a site's
  HTTPS record before the first TLS handshake to it: epoxy's `ech_dns`
  answers are kept in IndexedDB (`stomp-ech`, handed to epoxy as its
  `ech_cache`) until their TTL runs out. Through a local demo at the prod
  relay (headless Chrome 157, five alternating rounds), the first proxied
  byte of a reload came at 190 ms (median) against 250, and in a second
  tab at 197 against 276. Needs the epoxy build with epoxy-tls 0080 and
  epoxy-transport 0060; an older build ignores the store.

### Origin isolation

- epoxy's `ech_dns` answers are kept per network partition, as Chrome
  157's host cache keeps a name's records per top-level site (and apart
  for a frame cross-site to its top): one site's lookup no longer tells
  another whether a name was asked. An answer is kept for its TTL and
  never longer (the smallest TTL of the records taken; a name with no
  record for its SOA's negative TTL; nothing without one), where a TTL
  under 60 s was kept 60 s and a name with no record 5 minutes. The store
  is emptied when the network changes, as Chrome empties its host cache.
  `ech-cache` covers it in the worker and in the page.
