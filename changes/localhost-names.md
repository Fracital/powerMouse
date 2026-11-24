### Fixes

- A request to a name under `.localhost` (and any other name only the
  system resolver knows) connects. The built-in relay resolved names
  itself, from public DNS and `/etc/hosts`, so `www.localhost` and
  `www2.localhost` were NXDOMAIN while the browser treats every name
  under `.localhost` as loopback. The relay now asks a resolver that
  uses the system, so those requests are answered and carry the same
  Sec-Fetch and Origin headers as a direct load. (wpt-fetch-metadata,
  wpt-fetch-basic, wpt-fetch-cors, wpt-xhr-request and wpt-xhr-cors.)
