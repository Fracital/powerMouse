### Demo and API

- Tor mode builds its circuits in the browser wherever the server runs no
  Tor relay: arti, through tor-js 0.4.4, runs in the transport worker and
  the demo's `/wisp/` carries only TCP to Tor relays' ORPorts (the worker
  refuses a link to any address that is not a fallback directory or a relay
  of the consensus it holds), so neither the Wisp server nor the demo's
  server sees a destination or content. The Tor toggle is enabled,
  `config.js` says `torClient: true` and `/api/tor` answers
  `{"state":"client"}`; the Tor chip shows the bootstrap's progress in Tor
  Browser's phases, and the menu has New Identity and New Tor circuit for
  this site. Requests are isolated per top-level site, a request whose
  circuit gives no answer in 30 s is tried once on a new one, and WebSockets
  are refused. `STOMP_TOR_CLIENT=0` turns the client off; a configured relay
  (`STOMP_TOR_SOCKS5`, `STOMP_TOR_WISP_URL`) is used instead of it.
  docs/tor-over-wisp.md has the design, the wasm's provenance and the
  measurements, and `node test/tor-client-smoke.mjs` checks it against the
  real Tor network (`SKIP_NETWORK=1` skips it).
