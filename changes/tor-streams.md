### Demo and API

- Tor mode runs epoxy on Tor streams, with tor-js 0.4.4 built from source
  with a `connect()` stream API (deploy/tor-js) and pinned as
  `github:Fracital/tor-js`: an epoxy client for each top-level site,
  over a Wisp server in the transport worker whose every stream is a Tor
  stream on that site's circuits, so connections are kept and pooled per
  site, HTTP/2 is negotiated, WebSockets work and the site's TLS is
  epoxy's. UDP is refused. Requests no longer go through tor-js's own
  fetch, one Tor stream and TLS handshake each. (tor-streams,
  `test/tor-client-smoke.mjs`.)

### Deployment

- `deploy/tor-js/` builds tor-js from its pinned release plus `patches/` in
  a container, and `PATCHES=0` checks the unmodified release against the
  wasm hash tor-js's CI printed (it reproduces it). `publish.sh` puts the
  build on Fracital/tor-js's `dist` branch as an installable `tor-js`
  package, which package.json pins, so a deploy serves it with no
  container build.
