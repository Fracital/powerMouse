### Demo and API

- Tor mode can build its circuits in the browser (opt-in prototype,
  `?tor=client` or `STOMP_TOR_CLIENT=1`): arti, through tor-js 0.4.4, runs in
  the transport worker and the demo's `/wisp/` carries only TCP to Tor
  relays' ORPorts, so neither the Wisp server nor the demo's server sees a
  destination or content. Requests are isolated per top-level site; WebSockets
  are refused. docs/tor-over-wisp.md has the design and the measurements, and
  `node test/tor-client-smoke.mjs` checks it against the real Tor network
  (`SKIP_NETWORK=1` skips it).
