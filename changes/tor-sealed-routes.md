### Security

- Tor mode's routes no longer tell the host's server the sites a visitor
  opens. Some proxied requests reached the server at their route: a forced
  reload of a page in a tab of its own and that tab's favicon request (its
  Referer), a page's posts, beacons and images once its tab was gone and
  the worker had started again, a navigation to such a route, and a dialed
  page's about:blank frame, whose images went to the host as raw relative
  paths. The xor codec's routes are no encryption (a server that knows one
  page's URL reads the others), so Tor mode seals its routes with a new
  `siv` codec, deterministic authenticated encryption (SIV with
  HMAC-SHA-256 and AES-256-CTR) under a key the worker draws; its worker
  answers every request at its routes itself where it would have passed it
  on (an error, or a page saying the tab is gone), a synchronous
  XMLHttpRequest is refused rather than relayed through the host, and an
  about:blank document of a dialed page resolves against its creator's
  address. The demo's server answers a Tor route with a fixed 404. Normal
  mode keeps xor (demo-tor-routes, codec).

### Demo and API

- `codec: 'siv'`: routes encrypted rather than obscured (docs/codec.md, "The
  siv codec"). Its realms load `injectDocumentFull` and `injectWorkerFull`,
  as the aes and base64 codecs' do, and a directory of it never lets a
  request at its routes through to the host's server.
