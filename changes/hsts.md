### Security

- HSTS is kept: the worker drops a site's `Strict-Transport-Security`
  before the browser sees it (it would pin the proxy's host), so an
  `http:` URL of a site that sent it over https loaded over plain http,
  where Chrome upgrades it. The worker keeps the header itself
  (src/server/hsts.ts), from secure answers of hosts that are not IP
  literals: max-age (capped at a year, 0 forgets the host) and
  includeSubDomains, parsed as Chrome parses them. An http URL of a kept
  host goes out over https before anything of it is sent, after mixed
  content (a navigation or a request that follows redirects as a 307 to
  the https route, so the page sees the https URL), port 80 becoming 443,
  and a `ws:` socket connects as `wss:`. Each network partition keeps its
  own, as the connections are kept, so one site cannot read which hosts
  another set; kept in IndexedDB (the site pool's slots in the host's),
  and forgotten by `clearCache()`, `forgetStorage(origin)` and a
  Clear-Site-Data "cache" of the host (hsts suite).

### Known limitations

- HSTS has no preload list: a host is upgraded only after an https answer
  of its own in that network partition. Chrome keeps one HSTS store for
  the profile; STomp keeps one per network partition.
