### Demo and API

- Add Tor mode, a Tor client in the browser: the homepage's Tor checkbox
  remembers the choice, keeps a profile of its own (its own scope,
  `/stomp-tor/`, and stores, forgotten when Tor is turned off or its last
  tab closes) and never falls back to a direct connection; UDP, HTTP/3 and
  WebTransport are off in it. arti, through tor-js 0.4.4, runs in the
  transport worker and the demo's `/wisp/` carries only TCP to Tor relays'
  ORPorts (the worker refuses a link to any address that is not a fallback
  directory or a relay of the consensus it holds), so neither the Wisp
  server nor the demo's server sees a destination or content. The Tor toggle
  is enabled, `config.js` says `torClient: true` and `/api/tor` answers
  `{"state":"client"}`; the Tor toggle's tooltip and the status line show the
  bootstrap's progress in Tor Browser's phases, and the menu has New Identity and New Tor circuit for
  this site. Requests are isolated per top-level site
  (changes/tor-streams.md has how they go). `STOMP_TOR_CLIENT=0` turns Tor mode off. The demo's server
  still sees that a visitor uses Tor and which Tor guard they use; bridges,
  which would hide that, are future work. It runs in Chrome and Firefox.
  docs/tor-over-wisp.md has the design, the wasm's provenance and the
  measurements, and `node test/tor-client-smoke.mjs` checks it against the
  real Tor network (`SKIP_NETWORK=1` skips it).
