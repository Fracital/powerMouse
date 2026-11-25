### Performance

- Tor mode's first visit is ready in 1.2 to 1.3 s where the server serves
  a directory snapshot, where it took 1.0 to 5.0 s (median 3.6 s; Chrome,
  this machine, the real Tor network, 2026-11-25). Without a directory the
  client downloaded the consensus, the authority certificates and about
  9,550 microdescriptors through a fallback relay, as fast as that relay
  was; it now fetches `/tor-client/bootstrap.zip` (1.43 MB with brotli)
  from the app's origin beside the wasm's load and hands it to tor-js
  (`TorClient({ bootstrap })`), and arti loads it from its cache. A later
  visit is unchanged: it has a directory and fetches nothing.
  (docs/tor-over-wisp.md "The fast-bootstrap snapshot", test/tor-snapshot.mjs,
  the demo-tor-fail-closed suite.)

### Deployment

- `STOMP_TOR_BOOTSTRAP=<dir>` serves the snapshot in `<dir>` at
  `/tor-client/bootstrap.zip` and names it in `config.js`; unset, Tor mode
  starts as before. `node scripts/tor-snapshot.mjs --out <dir>` writes it
  (tor-js in Node over one-hop directory requests to the fallbacks, no tor
  daemon: about 4 MB downloaded, 170 MB of memory and 4 to 9 s a run), and
  `STOMP_TOR_BOOTSTRAP_EVERY=30` has the server run it at start and every
  30 minutes; a timer of the deployer's can instead. The file is the same
  for every visitor (no query, no cookie, `Cache-Control: no-cache` with
  an ETag), and a snapshot past its consensus's valid-until or half
  written is a 404.

### Security

- The server is not trusted with the snapshot. arti checks it through its
  cache path, the one a kept directory takes: the consensus's authorities
  and signatures against the authority certificates, each certificate's
  signature and expiry, and each microdescriptor by the digest the
  consensus lists; one byte of the consensus changed fails the start. The
  client refuses a snapshot at or past its consensus's valid-until (which
  arti's clock tolerance would take for three more days), holds every
  consensus write until arti says it loaded the snapshot, and after a
  refused one drops those writes and starts again without a snapshot, so
  a bad file costs a download and is never kept nor used to admit relays.
