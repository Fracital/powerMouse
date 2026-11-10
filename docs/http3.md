# HTTP/3 over wisp UDP

Chrome loads a site over HTTP/3 (QUIC) once the site has said it can, and
some sites behave differently over it (quic.nginx.org tells you which one you
got). With `http3` on, a proxied page gets the same: requests to an origin
that offers h3 travel as QUIC datagrams over a wisp UDP stream, the way the
user's own Chrome would send them, and everything else keeps going over the
transport's TCP connections. It is off by default.

```js
new StompController({
	serviceworker: registration,
	transport: {
		module: '/epoxy/index.mjs',
		options: [{ wisp }],
		http3: true, // or { force, dns, timeout, wait, module, pem }
	},
});
```

The demo turns it on with `STOMP_HTTP3=1` on the server or `?http3` on the
page (demo/README.md).

## Pieces

| Piece                                                    | Where                                                                      | What it does                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stomp-h3                                                 | `deploy/epoxy/h3/` (Rust, wasm32), shipped in epoxy-transport's `dist/h3/` | QUIC (quinn 0.11) and HTTP/3 (h3 0.0.8) over a datagram channel handed in from JS: a quinn `AsyncUdpSocket` over a `ReadableStream`/`WritableStream` pair, a quinn `Runtime` on `spawn_local` and `setTimeout`. Exposes `connect(host, readable, writable, options)` and `H3Connection.request(method, url, headers, body)`.                            |
| the datagram channel                                     | epoxy's `client.connect_udp('udp://host:port')`                            | A wisp UDP stream: one wisp DATA packet per datagram each way, so datagram boundaries survive. It shares the transport's one wisp connection; no new socket to the server.                                                                                                                                                                              |
| `Http3Transport`                                         | `src/transport/http3/`                                                     | Wraps the base transport (a `ProxyTransport`). Learns h3 origins, keeps one QUIC connection per origin, decides per request whether h3 is used, falls back. Exported from `dist/controller.mjs` for hosts that construct transports themselves (`new Http3Transport(base, options, moduleUrl)`; `options.udp` can supply another channel opener there). |
| `TransportDescriptor.http3`                              | `src/transport/construct.ts`                                               | The transport worker, the page host and the controller frame wrap the constructed transport when the descriptor asks for it. The module defaults to `h3/stomp_h3.js` next to the transport module (`/epoxy/h3/stomp_h3.js`).                                                                                                                            |
| `stomp_h3.js` + `stomp_h3_bg.wasm` (2.1 MB, 540 KB gzip) | fetched by the transport worker the first time an origin offers h3         | Nothing loads while no origin has offered h3.                                                                                                                                                                                                                                                                                                           |

## How a request goes

1. A response over the base transport (HTTP/1.1 or HTTP/2) carries
   `Alt-Svc: h3=":443"; ma=86400`. The wrapper keeps it for that origin
   (`URL.origin`) until its max-age, and starts a QUIC handshake to the
   origin in the background.
2. Requests that come while the handshake runs go over the base transport,
   with no wait. Once it is done, every request to the origin goes over the
   QUIC connection (multiplexed, up to 100 streams at once).
3. A connection that closes (30 s idle, GOAWAY, an error) is dropped; the next
   request reconnects. When QUIC already worked for the origin in this
   session, a request waits up to `wait` (300 ms) for that reconnect before
   it goes over the base transport instead.
   A connection whose wisp UDP stream ends (the stream closed, or the
   whole wisp connection was lost) is closed at once, so the requests on
   it fail over to the base transport now rather than at the idle timeout.
4. A handshake that fails (a TLS or QUIC error, the channel closed, nothing
   back within `timeout`, 10 s) marks the origin broken: 5 minutes, doubling
   on each consecutive failure up to 2 days, reset when QUIC works again.
   This is Chrome's `BrokenAlternativeServices`.
5. A wisp server that refuses UDP (wisp v2 without the UDP extension, or the
   stream closed at once) turns QUIC off for every origin for 5 minutes, like
   Chrome's "QUIC is blocked on this network".
6. An h3 request that fails before its response head is retried over the
   base transport when it is GET, HEAD or OPTIONS, or when its stream never
   opened (so it never reached the server); otherwise the error is the
   request's. Request bodies are buffered (or a stream teed) for that retry.

`info()` on an `Http3Transport` lists the alt-svc entries, the connections
with their RTT and datagram counts, and how the last 64 requests went.

## What matches Chrome

- Discovery: `Alt-Svc` (RFC 7838) from https responses only, `h3` only (the
  drafts such as `h3-29` are ignored, as current Chrome does), `ma` (default
  24 h), `clear`, and a new field replaces what the origin advertised before.
  HTTPS DNS records (RFC 9460) with `dns` set to a DNS-over-HTTPS URL (for
  example `https://cloudflare-dns.com/dns-query`): asked once per name in the
  background, through the base transport, and an `alpn` naming h3 counts like
  an Alt-Svc for the record's TTL. `force` lists origins to use h3 on without
  either, like `--origin-to-force-quic-on`.
- The alternative is used only for the origin that advertised it, and only
  on the origin's own host: an alt-authority naming another host is ignored,
  so a site cannot send another origin's requests to a server it names.
- Racing: Chrome races the QUIC job against the TCP job and lets the loser
  finish for later. The wrapper cannot see the base transport's connections,
  so it races connections the same way from the other side: the base
  transport serves until the QUIC connection is up, never the other way
  round, and no request waits on a handshake that has not worked yet.
- QUIC transport parameters: Chrome's 13, each in a random place:
  `max_idle_timeout` 30 s, `initial_max_data` 15 MiB,
  `initial_max_stream_data_*` 6 MiB, `initial_max_streams_bidi` 100,
  `initial_max_streams_uni` 103, `max_udp_payload_size` 1472,
  `max_datagram_frame_size` 65536, an empty `initial_source_connection_id`,
  `version_information` (version 1, then version 1 and a random reserved
  version in random order), `google_connection_options` `ORIG` and a GREASE
  parameter of 0 to 15 random bytes. No greased fixed bit, an 8-byte first
  destination connection ID, every Initial datagram 1250 bytes and no path
  MTU probes (Chrome sends none; the packets stay at 1250), initial RTT
  100 ms, Cubic. Measured against Chrome 152 (docs/fingerprint.md).
- TLS inside QUIC: TLS 1.3 only, ALPN `h3`, Chrome's cipher order
  (AES-128-GCM, AES-256-GCM, ChaCha20-Poly1305), session resumption (one
  rustls config per worker), webpki roots.
- HTTP/3: Chrome's SETTINGS in its order, `QPACK_MAX_TABLE_CAPACITY` 65536,
  `MAX_FIELD_SECTION_SIZE` 262144 (256 KiB, the limit the epoxy HTTP/2 patch
  sets, so a 20 KB YouTube header block works on both),
  `QPACK_BLOCKED_STREAMS` 100, `H3_DATAGRAM` 1 and a GREASE setting (id
  `0x1f * N + 0x21` with a random 32-bit N, a random 32-bit value) last,
  then a GREASE frame of 0 to 3 random bytes, then a PRIORITY_UPDATE for
  every request with a Priority field (its value, before the request's
  HEADERS). No GREASE stream and no GREASE frames on request streams, as
  Chrome. Unidirectional streams open in Chrome's order (control, QPACK
  decoder, QPACK encoder) and a QPACK stream's type goes out with its first
  instruction. Responses decode with the server's QPACK dynamic table
  (patched h3: blocked streams wait for their entries, sections that used
  the table are acknowledged); pseudo-headers in Chrome's order
  (`:method`, `:authority`, `:scheme`, `:path`; h3 0.0.8 writes `:scheme`
  before `:authority`, patched in `deploy/epoxy/h3/patches/h3/`);
  connection-specific fields (`connection`, `keep-alive`, `transfer-encoding`,
  `upgrade`, `host`, a `te` other than `trailers`) are dropped as RFC 9114
  requires; `user-agent` and `accept-encoding: gzip, br` added when absent, as
  epoxy does, and gzip and br bodies decoded the same way, so either path
  hands STomp the same response.
- 0-RTT is off. Early data can be replayed by an attacker and the proxy
  cannot tell which of a page's requests are safe to replay, so every
  connection does the full 1-RTT handshake (resumed when it can).
- Response bodies stream (a `ReadableStream` straight to STomp's body port),
  request bodies go up as they are read, and both directions run at once.

## Limits

- Only transports with `client.connect_udp` (epoxy) can carry it. libcurl.js
  has no UDP API; with libcurl the option does nothing.
- The client's QPACK encoder uses the static table only: Chrome inserts
  its request fields into the server's dynamic table when the server allows
  one (encoder stream instructions, then HEADERS that reference them), so
  a server that looks at how requests are compressed can tell. Responses
  decode with the dynamic table (above).
- An abandoned request whose response section waits on the dynamic table
  sends no Stream Cancellation instruction; the server's encoder keeps
  counting it as blocked.
- Chrome's packets to an IPv6 address are 20 bytes shorter (1230); the wisp
  server picks the address family, so stomp-h3 always sends 1250.
- No connection migration or port changes: the wisp stream is the path.
- Bulk downloads are slower over h3 than over h2 through wisp: every 1.4 KB
  datagram is its own wisp frame and crosses into JS and back twice, where
  h2 moves 16 KB records. Measured 20 MB from dl.google.com: 5 to 8 MB/s over
  h3 against 7 to 18 MB/s over h2 on the same wisp. Small requests cost the
  same either way (warm medians within a few ms).
- The alt-svc cache lives as long as the transport (the transport worker of
  one controller); Chrome keeps it on disk. A new tab learns it again from
  the first response.
- WebSockets stay on the base transport (no RFC 9220).
- Abort signals are not passed down, as with epoxy itself.

## Wisp servers

The QUIC packets leave from the wisp server as UDP, so the server has to
relay UDP streams.

| Server                                                                                          | UDP                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the demo's built-in `/wisp/` (holyWisp, a child process of the demo server)                     | on (`allowUDP`); `WISP_NO_UDP=1` turns it off for testing                                                                                                                           |
| holyWisp, the public `wss://holywisp.fracit.al/` relay and the keyed Fracital path on the edges | on since abulxt 853761c7: `holywisp_allow_udp: true` and `holywisp_proxy_udp_direct: true` render `allow-udp = on` and `proxy-udp = direct` (the edge egress proxy only speaks TCP) |
| holyWisp on amph (abulxt's own relay)                                                           | on, `proxy-udp = direct` (mullvad-pool is TCP only)                                                                                                                                 |

With UDP off the option costs nothing: the first UDP stream is refused at
once and QUIC stays off for 5 minutes at a time. The edges turned it on
(abulxt 853761c7) with, in `deploy/ansible/inventory/group_vars/edge.yml`:

```yaml
holywisp_allow_udp: true
# the edges' proxy (edge-router.py) is TCP only: UDP leaves from the edge
# itself, without edge-router's name classification
holywisp_proxy_udp_direct: true
```

applied with `ansible-playbook playbooks/edges.yml --tags wisp --vault-password-file ~/.abulxt-vault-pass`.
That renders `allow-udp = on` and `proxy-udp = direct`; holyWisp then
resolves the name itself (`dns-server`, 1.1.1.1), applies the same egress
policy (no private, loopback or link-local addresses) and sends the
datagrams from the edge's own address. UDP streams bypass edge-router.py's
adult and shady-name classification, which is a policy choice for abulxt to
make, and the edges' outbound UDP must not be filtered (the edge firewall
only filters inbound). Nothing in STomp's deployment changes: terp's
`STOMP_WISP_URL` stays the relay, and the page enables `http3` in its
transport descriptor.

A datagram crosses wisp whole, as one DATA packet. Epoxy refuses one over
64 KiB (above the 65507 bytes an IPv4 datagram carries) with `EMSGSIZE`
before it reaches the server, whose message bound would otherwise close
the whole connection. Through `send(datagram)` on the stream `connect_udp`
returns, that fails the one call and the stream stays usable; a rejected
`write` errors the WritableStream, as any rejected write does. QUIC's
1250-byte packets are far below it.

## Building and testing

`deploy/epoxy/build.sh` builds stomp-h3 in the same container as epoxy
(`deploy/epoxy/h3/build.sh`: `vendor.sh` fetches h3 0.0.8, checks its
crates.io checksum and applies `patches/h3/`; then a locked release build,
wasm-bindgen 0.2.100 for the web target, wasm-opt) and puts it in
`out/epoxy-transport/dist/h3/`, so `publish.sh` ships it on the
EpoxyTransport `dist` branch with everything else.

- `http3-fallback` (no network): a stand-in base transport and refused,
  closed and black-hole datagram channels. Alt-Svc parsing (http origins,
  other hosts, drafts, `ma`, `clear`), no wait during a handshake, broken
  marking, the UDP-refused switch, a forced origin's bounded wait, and a
  module that does not load.
- `http3` (network): quic.nginx.org reports h3 through the proxy with a wisp
  that relays UDP and reports not h3, as fast, through one that refuses it;
  raw requests over h3 to quic.nginx.org, cloudflare-quic.com, www.google.com
  (gzip), www.youtube.com (a header block over 16 KiB, on h2 and h3) and
  pie.dev (a request body and a streamed one echoed back), with timings.
