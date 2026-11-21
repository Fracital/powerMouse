### Deployment

- The demo server's Tor relay is gone: `/wisp-tor/`, `demo/torWisp.js` and
  its settings (`STOMP_TOR_SOCKS5`, `STOMP_TOR_WISP_URL`, `STOMP_TOR_CONTROL`,
  `STOMP_TOR_PROBE` and the other `STOMP_TOR_*` but `STOMP_TOR_CLIENT`). It
  saw every destination of every visitor, which Tor mode must not. A server
  that still sets one starts as before and logs one line that it is
  ignored; Tor mode is the in-browser client, and the server needs no tor
  daemon. `STOMP_TOR_CLIENT=0` turns Tor mode off. A deployer who wants the
  server's own egress through Tor can point `STOMP_WISP_URL` at a Wisp
  server with a SOCKS upstream.
