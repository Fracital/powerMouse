# HTTP/3 over wisp UDP

Chrome loads a site over HTTP/3 (QUIC) once the site has said it can, and
some sites behave differently over it (quic.nginx.org tells you which one you
got). With `http3` on, a proxied page gets the same: requests to an origin
that offers h3 travel as QUIC datagrams over a wisp UDP stream, the way the
user's own Chrome would send them, and everything else keeps going over the
transport's TCP connections. It is off unless the host's descriptor asks
for it; the demo asks for it by default.

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

The demo has it on by default: `STOMP_HTTP3=0` on the server turns it off,
`?http3=0` on the page turns it off for one visit and `?http3` on for one
(demo/README.md). The demo-http3 suite checks the default, the switches,
that a page loads on time where QUIC cannot be had, and that a wisp server
refusing UDP to one name leaves HTTP/3 on for the rest of the session.

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
5. A UDP stream the wisp server ends before any datagram has come back on
   it was refused (wisp has no answer to CONNECT: a server that will not
   relay a stream closes it, at once or when its first datagram arrives),
   and so was one that could not be opened. A refusal is about that
   destination: it marks the one origin broken as in 4, its requests go
   over the base transport at once, its stream is not asked for again until
   the mark runs out, and every other origin keeps its HTTP/3. The relay
   itself is taken to have no UDP, which turns QUIC off for every origin
   for 5 minutes, only on evidence about the relay:
   - the server says so: a wisp v2 server that did not announce the UDP
     extension (epoxy fails the open with `ExtensionsNotSupported`, and no
     origin is marked broken for it); or
   - 8 distinct hosts were refused while no datagram had come back on any
     UDP stream of this wisp connection. A refusal counts when its close
     reason is one a server also gives with UDP off altogether (`0x48`,
     `0x42`) or the transport does not report the reason (the table under
     Wisp servers); one with any other reason (`0x03`, the edges' name
     gate) never counts.

   A datagram coming back on any stream shows that the relay carries UDP:
   the count is dropped and not kept again on this wisp connection, and a
   verdict reached by counting is withdrawn at once (a stream opened before
   the verdict may still carry). The count also starts over when the 5
   minutes begin. A new wisp connection (the base transport built again
   after the old one was lost, or a UDP stream that could not be opened
   because the connection was gone) starts from nothing, since another
   edge may answer it: no verdict, no count, and the origins the old relay
   refused are tried again. Origins whose QUIC failed for their own reasons
   (rule 4) stay broken.

6. An h3 request that fails before its response head is retried over the
   base transport when it is GET, HEAD or OPTIONS, or when its stream never
   opened (so it never reached the server); otherwise the error is the
   request's. Request bodies are buffered (or a stream teed) for that retry.

`info()` on an `Http3Transport` lists the alt-svc entries (with which are
broken, and which of those by a refusal), the connections with their RTT and
datagram counts, how the last 64 requests went, and what is known of the
relay: `udpBlockedUntil`, `udpCarried` and the hosts in `udpRefused`.

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

With UDP off the option costs nothing: an origin's UDP stream is refused at
once and the origin stays on the base transport, and after eight hosts QUIC
is off for 5 minutes at a time (rule 5). The edges turned it on
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

A wisp server may send its TCP and UDP streams from different addresses,
and then a session with `http3` on reaches a site from both. The edges do:
TCP streams go through edge-router.py and arrive from one IPv6 address,
UDP streams leave from the edge itself and arrive from an IPv4 one
(measured 2026-11-10 through `wss://holywisp.fracit.al/`, six connections
alike: a STUN binding request on a UDP stream and an HTTP request to
redirector.googlevideo.com/report_mapping on a TCP stream name the address
each arrives from). The first requests to an origin go over TCP, so a
YouTube watch page is fetched from the one address and its later requests
come from the other. A server that sends
both from one address (the demo's built-in `/wisp/` on an ordinary machine)
does not split a session this way.

### What a refused UDP stream looks like

Wisp has no answer to CONNECT, so a server that will not relay a UDP stream
sends CLOSE with a reason, and the client cannot tell from one stream
whether the server refuses this destination or every one. What the servers
send, read from their source (holyWisp 0.5.2 `src/server/conn.c` and
`stream.c`; wisp-js 0.5.3 `src/server/connection.mjs`, `filter.mjs` and
`net.mjs`) and, where a cell does not say "read", measured 2026-11-10 with
epoxy against both servers run locally:

| Case                                                                                                                             | holyWisp 0.5.2                                                                                                                                                                                            | wisp-js 0.5.3                                                                                                 | About               |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| UDP off on the whole relay                                                                                                       | `allow-udp = off`: a wisp v2 INFO without the UDP extension (epoxy then fails the open itself); `0x48` on CONNECT for a wisp v1 client (epoxy's default)                                                  | `allow_udp_streams: false`: the same, except `0x03` for a name that does not resolve (the lookup comes first) | the relay           |
| UDP off behind a proxy                                                                                                           | `proxy-udp = refuse` with a `proxy`: `0x48` on CONNECT; the v2 INFO still announces UDP                                                                                                                   | no such setting                                                                                               | the relay           |
| A destination the server blocks: a host or port on its lists, a literal IP where none are allowed, a private or loopback address | `0x48` (read: also a destination its reputation store refuses)                                                                                                                                            | `0x48`                                                                                                        | the destination     |
| A name the edges' gate closes to UDP (abulxt, not deployed yet)                                                                  | read, and measured by the edge work: the stream opens, and the first datagram sent on it is answered with `0x03` (the edge's `send()` fails with `EPERM`, an errno holyWisp has no reason of its own for) | not applicable                                                                                                | the destination     |
| A name that does not resolve                                                                                                     | `0x42`                                                                                                                                                                                                    | `0x03`                                                                                                        | the destination     |
| A port that answers a datagram with ICMP unreachable                                                                             | `0x42`                                                                                                                                                                                                    | `0x02`                                                                                                        | the destination     |
| An address with no route                                                                                                         | `0x42` (read)                                                                                                                                                                                             | `0x03` (read)                                                                                                 | the destination     |
| A CONNECT the server cannot use (port 0)                                                                                         | `0x41`                                                                                                                                                                                                    | `0x41` (read)                                                                                                 | the request         |
| The server's limits: streams per connection, connects per source or destination, a full queue                                    | `0x49` (read)                                                                                                                                                                                             | `0x49`                                                                                                        | the client          |
| A stream that opens and whose datagrams go nowhere                                                                               | no CLOSE, nothing comes back                                                                                                                                                                              | no CLOSE, nothing comes back                                                                                  | the origin (rule 4) |

Read only: epoxy-server answers `0x48` with `allow_udp = false`, and
wisp-server-python answers `0x42` with `--block-udp`, which is also its
answer to any stream it could not open. So `0x48` and `0x42` are what a
relay without UDP says, and both are also said about one destination;
`0x03` is never said about the relay. A refusal arrives one wisp round trip
after the CONNECT or the first datagram (2 to 11 ms through a local
server).

Epoxy ends the stream's read side the same way whatever the reason was. A
build with `deploy/epoxy` patch `0058` adds `closeReason()` to the stream
`connect_udp` returns, and `Http3Transport` reads it when the stream ends;
a build without it reports no reason and every refusal counts.

Eight hosts, because a refusal is nearly free (two small wisp packets, in
the background, and no request waits on it) and a wrong verdict costs every
origin its HTTP/3 for 5 minutes. Measured 2026-11-10, ten sites loaded once
in Chrome without a proxy, counting the hosts whose responses offered h3:
1 to 50 a page (YouTube 10, CNN 15, Discord 8, Twitch 5, Reddit and TikTok
4, Google and Amazon 3, GitHub 1, the New York Times 50), the first few
often one party's (CNN's first four its own, all of YouTube's Google's).
Eight are reached within one page on four of the ten, so a relay without
UDP is found out within a few pages, and a site whose own few names are
refused does not make the count before another party's stream carries.
With a transport that reports no close reason, a wisp connection whose
first eight hosts are all refused for themselves is still taken for a relay
without UDP, for 5 minutes.

A datagram crosses wisp whole, as one DATA packet. Epoxy refuses one over
64 KiB (above the 65507 bytes an IPv4 datagram carries) with `EMSGSIZE`
before it reaches the server, whose message bound would otherwise close
the whole connection. Through `send(datagram)` on the stream `connect_udp`
returns, that fails the one call and the stream stays usable; a rejected
`write` errors the WritableStream, as any rejected write does. QUIC's
1250-byte packets are far below it.

## YouTube's attestation

YouTube decides whether a watch session's video keeps streaming (the SABR
`STREAM_PROTECTION_STATUS`: 2 pending, 1 accepted, 3 attestation required,
after which the video stops when its buffer runs out, at about 45 seconds)
by the network path of the session's requests, and HTTP/3 is part of that
path. Measured 2026-11-10, headful Chrome 152 on a private display, a fresh
profile for every load, four public videos, arms alternated in one batch,
refused loads of those with a verdict:

| Arm (from a machine behind a WireGuard tunnel unless it says edges) | Refused  |
| ------------------------------------------------------------------- | -------- |
| Chrome, no proxy                                                    | 0 of 56  |
| Chrome, no proxy, `--disable-quic`                                  | 13 of 36 |
| STomp, HTTP/2, wisp-js on the machine                               | 14 of 20 |
| STomp, HTTP/2, holyWisp 0.5.2 on the machine                        | 13 of 20 |
| a build with holyWisp as its built-in `/wisp/`, HTTP/2              | 12 of 19 |
| STomp, `http3`, wisp-js on the machine                              | 1 of 20  |
| a build with holyWisp as its built-in `/wisp/`, `http3`             | 1 of 16  |
| STomp, HTTP/3 for every host but googlevideo.com (an experiment)    | 3 of 16  |
| STomp, HTTP/3 for googlevideo.com only (an experiment)              | 9 of 16  |
| STomp, HTTP/2, the holyWisp edges                                   | 4 of 36  |
| STomp, `http3`, the holyWisp edges                                  | 3 of 20  |

What follows from it:

- The wisp server does not matter: wisp-js and holyWisp on the same machine
  are refused alike. Where its connections leave from does.
- From that machine every connection, Chrome's and the wisp server's, TCP
  and UDP, left from one IPv4 address through the tunnel (the sockets'
  local address, and what STUN and redirector.googlevideo.com/report_mapping
  answered). Chrome is accepted there because it speaks QUIC: limited to
  TCP it is refused too. One STomp build ran the wisp-js arms with and
  without `http3`, so what the page sees of its JavaScript environment is
  not what decides.
- The connections that count are the ones the page makes to youtube.com
  and google.com, where the attestation runs and the token the player
  attaches is issued, not the one to googlevideo.com the video streams
  over.
- What YouTube holds against TCP connections from that address is not
  known. The tunnel shows in every SYN (an MSS of 1320, the tunnel's 1360
  MTU), and the refusals over TCP rose through a day of measurements (about
  one load in four in the morning, two in three by evening; through the
  edges 0 of 21 in the batch before these, then 1 of 16, then 3 of 20),
  which looks like the address's history. Over QUIC they stayed where
  they were.
- Through the edges `http3` made no difference in 20 loads. There the
  session is split across two addresses (above).

So a host whose users see YouTube stop turns `http3` on, and one that
already has looks at where its wisp server's TCP and UDP streams leave
from. The demo has had it on by default since.

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
  marking, a forced origin's bounded wait, and a module that does not load.
  Rule 5 with a stand-in for stomp-h3 whose handshake is a datagram out and
  one back: one origin refused beside one that works, a relay that refuses
  every stream (by reason), refusals that never count, the verdict
  withdrawn, a new wisp connection. Then the same through a real epoxy
  client and the demo's wisp server behind `test/wisp-gate.mjs`, a relay
  that refuses UDP to one name as the edges' gate does, or to all, and can
  drop its connections.
- `demo-http3` (no network): the demo's default and switches, a wisp server
  without UDP, and one behind the gate: the refused origin's page and
  requests arrive over TCP on time, its stream is asked for once, and the
  next origin's stream is still asked for.
- `http3` (network): quic.nginx.org reports h3 through the proxy with a wisp
  that relays UDP and reports not h3, as fast, through one that refuses it;
  raw requests over h3 to quic.nginx.org, cloudflare-quic.com, www.google.com
  (gzip), www.youtube.com (a header block over 16 KiB, on h2 and h3) and
  pie.dev (a request body and a streamed one echoed back), with timings.
