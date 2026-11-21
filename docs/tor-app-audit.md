# Tor app review

The local `tor.app` directory is a compiled Anura Tor client, with `index.html`,
`lib.js`, `libcurl_full.js`, `main.mjs`, `main.worker.mjs` and `main.wasm`.
There is no source repository, package manifest, README or test suite with it.
Its Tor instance runs in Emscripten WASM with Snowflake WebRTC, an in-browser
SOCKS-like adapter and libcurl. Its `TorConnectionSocket` is not a Wisp
transport, and `index.html` expects the Anura runtime. No files from that
directory are included in STomp.

Problems found while auditing the supplied compiled JavaScript:

- `lib.js` `WebRTCConn.readFrom` (around lines 349-386) removes an entire
  DataChannel message even when its caller's buffer is too short. In an
  isolated replay, a six-byte message read into four bytes lost the last two.
- `lib.js` `BrowserSocksListener` (around lines 13-98) accepts malformed,
  fragmented SOCKS5 greetings and CONNECT requests without parsing the
  destination and port. A one-byte greeting and two-byte CONNECT were accepted
  in an isolated replay, with destination `unknown` and port `0`.
- `lib.js` `EncapsulatedPacketConn.readFrom` (around lines 1975-2020) consumes
  an oversized packet while returning only the part that fit the buffer.
- `lib.js` `TorConnectionSocket.handleReceive` (around lines 8583-8640) tests
  whether the status line contains the characters `200`, rather than parsing
  the exact HTTP status code. An isolated replay of `HTTP/1.1 4200 Denied`
  incorrectly opened the connection. Its event listeners, close handling and
  raw-byte console logging need attention before reuse.
- `lib.js` `UDPSession.readLoop` (around lines 1363-1398) can leave blocked
  readers or writers waiting after an EOF or transport error.
- `index.html` (around lines 20-88) replaces Anura's libcurl transport and
  fetch, but its cleanup condition does not correspond to the object it
  changed. The old transport reference aliases the mutated object, and the
  library's global WebSocket override is not restored.
- The WASM runtime eagerly starts roughly thirty pthread workers. It requires
  cross-origin isolation, SharedArrayBuffer and the matching WASM/worker
  files. The `libcurl_full.js` header carries LGPLv3 terms: provenance and
  corresponding source obligations need review before distributing it.

The syntax of the bundled scripts was checked, and small no-network Node
replays confirmed the buffer loss, invalid SOCKS handshake and invalid HTTP
status acceptance. Live Tor bootstrap, Snowflake broker behavior and complete
connection recovery were not validated. These findings concern the supplied
archive; no changes were made to it.

STomp's demo Tor mode uses its existing Wisp transports and a separate
Tor-backed relay, so these defects do not enter the proxy or its inject bundle.
