### Demo and API

- Tor mode runs epoxy on Tor streams where the server has deploy/tor-js's
  build of the client (`deploy/tor-js/build.sh`, tor-js 0.4.4 from source
  with a `connect()` stream API): an epoxy client for each top-level site,
  over a Wisp server in the transport worker whose every stream is a Tor
  stream on that site's circuits, so connections are kept and pooled per
  site, HTTP/2 is negotiated, WebSockets work and the site's TLS is
  epoxy's. UDP is refused. Without the build (the npm release) Tor mode
  goes through tor-js's own fetch as before. (tor-streams,
  `test/tor-client-smoke.mjs`.)

### Deployment

- `deploy/tor-js/` builds tor-js from its pinned release plus `patches/` in
  a container, and `PATCHES=0` checks the unmodified release against the
  wasm hash tor-js's CI printed (it reproduces it). `demo/server.js` serves
  `deploy/tor-js/out/dist` at `/tor-client/tor-js/` when a build is there.
