### Fixes

- A malformed `STOMP_TOR_SOCKS5` (or `STOMP_TOR_CONTROL`, `STOMP_TOR_PROBE`,
  `STOMP_TOR_WISP_URL`) no longer crashes the demo server at startup: it
  warns (`Tor Wisp disabled: ...`) and the server starts without Tor, as
  when the Tor relay cannot start. (test/tor-wisp.mjs.)
