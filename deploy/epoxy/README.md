# epoxy-transport: upstream plus patches

The demo (and Fracital) install `@mercuryworkshop/epoxy-transport` from a
build made here, not from npm. The published package resets any HTTP/2
response whose header block is larger than 16 KiB (hyper's default) with
`PROTOCOL_ERROR`; YouTube sends 12 to 20 KB, so it failed through epoxy.
Chrome allows 256 KiB. The build also fixes two hangs: requests started in
one tick on a cold transport (all but one never answered) and a request
handed a keep-alive connection the server had already closed (see the
`epoxy-concurrency` suite). And it reads an HTTP/1 response with a malformed
header line the way Chrome does, where hyper refused the whole response (see
the `malformed-headers` suite). And its WebSocket handshake goes out as
Chrome's does: origin-form, with the port in Host, one User-Agent, Chrome's
fields in Chrome's order, ALPN `http/1.1`, and the server's subprotocol
reported (see the `ws-handshake` suite); TikTok's socket answered 400 to the
absolute-form request line before. A close the server starts reaches the
page with the server's code and reason (it read 1000 "Closed by remote"
whatever the server sent; `websocket-close` suite), and an IPv6 literal
(`https://[::1]:8443/`) connects (`epoxy-ipv6` suite). And its TLS ClientHello, HTTP/2 SETTINGS,
priorities and pseudo-header order, and its HTTP/1 field order and spelling
are Chrome's (JA4, Akamai and JA4H equal to Chrome 152's; see
`docs/fingerprint.md`), and with `ech_dns` it offers real Encrypted Client
Hello to a site whose HTTPS DNS record has a config, with Chrome's outer and
inner hello and Chrome's retries. Its writes go out as wisp packets of at
most 64 KiB within each stream's flow control credit, so a wisp server that
bounds its messages (the holyWisp relays, 262149 bytes) no longer closes the
whole connection over an upload (see the `wisp-message-size` suite).
And every WebSocket frame it writes is flushed: the page's message, its
close and the answers to the server's ping and close waited in the wisp
stream for the next write, so a server answering the page looked silent
(see the `websocket-frames` suite).
And each response says which HTTP version it came over, so STomp keeps
Chrome's six connections to an HTTP/1 server (`connection-limits` suite).
And a request whose kept-alive connection the server closed as the request
reached it goes again on another connection, as Chrome sends it (see the
`idle-close-retry` suite).
And a stream's CLOSE is read after the data that came before it: epoxy
dropped what a stream had received but not yet handed on, so a body read
slower than the wire from an HTTP/1.1 server that closed its idle
connection ended short (`slow-body-close` suite).
The build also carries stomp-h3, HTTP/3 over wisp
UDP for STomp's `http3` option (`h3/`, below), whose QUIC ClientHello and
transport parameters are Chrome's too.

Nothing is forked in the sense of a diverging tree. `upstream.env` pins the
seven upstream revisions, `patches/` holds `git format-patch` output applied
on top of them, and `build.sh` does the rest in a container. Bumping upstream
means changing a revision and rebuilding; a patch that no longer applies
fails the build at `git apply --check`.

| Repo                                                           | Patch  | What it does                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r58Playz/hyper-util-wasm (hyper-util for wasm, used by epoxy)  | `0001` | Exposes `http2_max_header_list_size` on the legacy client builder, forwarding to hyper's HTTP/2 builder.                                                                                                                                                                                                                                                                          |
| MercuryWorkshop/epoxy-tls                                      | `0001` | Sets that limit to 256 KiB in the client.                                                                                                                                                                                                                                                                                                                                         |
| MercuryWorkshop/epoxy-tls                                      | `0002` | `[patch]` in the workspace `Cargo.toml` so hyper-util-wasm comes from the sibling checkout.                                                                                                                                                                                                                                                                                       |
| MercuryWorkshop/epoxy-tls                                      | `0003` | wisp: a stream's `poll_close` polls the actor's flume sink after `start_send` (which only queues the close event) instead of returning `Pending`, so the close is sent and finishes. Before, hyper's shutdown of a connection the server closed while idle never completed, its pool kept the dead connection and the next request on it hung.                                    |
| hyperium/hyper (v1.6.0, the version epoxy-tls's lock resolves) | `0001` | The HTTP/1 client rewrites a lone CR in a response head before httparse sees it (httparse refuses it even with `ignore_invalid_headers_in_responses`): inside a line it ends the line, at the start of one it moves before the previous LF, before another CR it is trailing whitespace. Chrome splits header lines on CR. NUL is left fatal, as it is in Chrome.                 |
| MercuryWorkshop/epoxy-tls                                      | `0004` | `[patch.crates-io]` so hyper comes from the sibling checkout.                                                                                                                                                                                                                                                                                                                     |
| MercuryWorkshop/epoxy-tls                                      | `0005` | Turns on `http1_ignore_invalid_headers_in_responses` (skip a line with no colon or a control character), `http1_allow_spaces_after_header_name_in_responses` and `http1_allow_obsolete_multiline_headers_in_responses`, which Chrome all reads.                                                                                                                                   |
| MercuryWorkshop/epoxy-tls                                      | `0006` | Response header values reach JS as byte strings (one code unit per byte) instead of through `HeaderValue::to_str`, whose `?` failed the whole response over one byte past 0x7E.                                                                                                                                                                                                   |
| MercuryWorkshop/epoxy-tls                                      | `0007` | WebSocket handshake: the request-target is origin-form (`GET /path?query`) instead of the whole `wss://host/path` URL hyper's connection-level client wrote. Akamai, in front of TikTok's `im-ws.tiktok.com`, answered that with 400 "Invalid URL" to every handshake.                                                                                                            |
| MercuryWorkshop/epoxy-tls                                      | `0008` | WebSocket handshake: `Host` names the port when it is not the scheme's default (`ws://h:38155/` sent `Host: h`).                                                                                                                                                                                                                                                                  |
| MercuryWorkshop/epoxy-tls                                      | `0009` | WebSocket handshake: one User-Agent (the caller's replaces the client's; both went out), the caller cannot set Host, Connection, Upgrade, the key, the version or an extension epoxy cannot decode, Chrome's `Pragma`/`Cache-Control: no-cache` and `Accept-Encoding: gzip, deflate, br, zstd`, protocols joined with `, `, and the fields in Chrome's order.                     |
| MercuryWorkshop/epoxy-tls                                      | `0010` | A wss connection's ClientHello offers ALPN `http/1.1`, as Chrome's does for a WebSocket; it offered no ALPN at all.                                                                                                                                                                                                                                                               |
| MercuryWorkshop/epoxy-tls                                      | `0011` | WebSocket `onopen` gets the subprotocol the server chose (a page's `WebSocket.protocol` was always `""`), and a protocol the client did not offer fails the connection, as in a browser.                                                                                                                                                                                          |
| MercuryWorkshop/EpoxyTransport                                 | `0001` | Builds against the sibling epoxy-tls (`file:`), makes it a devDependency (it is bundled), pins TypeScript 5 for the type bundler, version `3.0.2-fracital.1`, stops ignoring `dist/`.                                                                                                                                                                                             |
| MercuryWorkshop/EpoxyTransport                                 | `0002` | `init()` loads the wasm module once per realm and builds one client per transport, however many calls overlap. Two concurrent inits instantiated the module twice and the client built on the replaced instance never answered.                                                                                                                                                   |
| MercuryWorkshop/EpoxyTransport                                 | `0003` | `connect` passes that subprotocol on to `onopen` (it reported `""`).                                                                                                                                                                                                                                                                                                              |
| r58Playz/h2-wasm (h2 for wasm, the revision Cargo.lock pins)   | `0050` | The client sends its pseudo-headers in Chrome's order, `:method :authority :scheme :path` (h2 wrote `:scheme` before `:authority`).                                                                                                                                                                                                                                               |
| r58Playz/h2-wasm                                               | `0051` | Every request's HEADERS frame carries a priority, exclusive, weighted by the request's `priority` field urgency as Chrome weighs it (u=0 is 256, u=1 220, none 147).                                                                                                                                                                                                              |
| r58Playz/h2-wasm                                               | `0052` | The priority's parent is the newest open stream of the same or a higher urgency, Chrome's HTTP/2 priority tree.                                                                                                                                                                                                                                                                   |
| rustls 0.23.29 (the crates.io release Cargo.lock pins)         | `0050` | `ClientConfig::chrome_hello`: Chrome's ClientHello (its cipher suites, GREASE everywhere Chrome puts it, SCT, renegotiation_info, ALPS with the client's EncryptedExtensions, a GREASE ECH, trust anchor ids, random extension order); SCT and trust anchor answers in certificate entries are skipped, ECH retry configs answering the GREASE ignored.                           |
| hyperium/hyper                                                 | `0050` | HTTP/1 title case spells field names as Chrome does: `sec-ch-*` lowercase, `Sec-WebSocket-*`, `DNT`.                                                                                                                                                                                                                                                                              |
| r58Playz/hyper-util-wasm                                       | `0050` | Exposes `http2_header_table_size` on the legacy client builder.                                                                                                                                                                                                                                                                                                                   |
| r58Playz/hyper-util-wasm                                       | `0051` | An HTTP/1 request starts with Host and Connection, as Chrome's does (Host went last), and leaves out the HTTP/2-only Priority field.                                                                                                                                                                                                                                              |
| MercuryWorkshop/epoxy-tls                                      | `0050` | `[patch.crates-io]` so h2 and rustls come from the sibling checkouts.                                                                                                                                                                                                                                                                                                             |
| MercuryWorkshop/epoxy-tls                                      | `0051` | Chrome's HTTP/2 SETTINGS (`1:65536;2:0;4:6291456;6:262144`, no MAX_FRAME_SIZE) and connection window (WINDOW_UPDATE 15663105).                                                                                                                                                                                                                                                    |
| MercuryWorkshop/epoxy-tls                                      | `0052` | Request fields go out in the caller's order behind Chrome's head (Content-Length, then the caller's; Connection last so HTTP/2 stripping keeps the order), Accept-Encoding `gzip, deflate, br, zstd` with deflate and zstd decoded too, HTTP/1 title case on.                                                                                                                     |
| MercuryWorkshop/epoxy-tls                                      | `0053` | HTTP and WebSocket connections use `chrome_hello`, Chrome's groups with X25519MLKEM768 (ring X25519 plus RustCrypto `ml-kem`) and brotli certificate decompression.                                                                                                                                                                                                               |
| MercuryWorkshop/EpoxyTransport                                 | `0050` | `fieldSupport` tells the host this build decodes every encoding Chrome offers and keeps Priority to HTTP/2 (STomp's serveTransport reads it).                                                                                                                                                                                                                                     |
| MercuryWorkshop/epoxy-tls                                      | `0054` | A WebSocket's `onclose` gets the server's close frame: its status and its reason (1005 for a frame without a status, 1006 for a connection that ended with no close frame, an empty reason when it is not UTF-8). The read loop dropped the frame and called `onclose` with nothing.                                                                                              |
| MercuryWorkshop/epoxy-tls                                      | `0055` | An IPv6 literal's host goes to the wisp server and to rustls without the brackets the URL writes around it: `[::1]` was neither a DNS name nor an address for rustls ("invalid DNS name") and the wisp server could not resolve it. Host keeps the brackets.                                                                                                                      |
| MercuryWorkshop/EpoxyTransport                                 | `0051` | `connect` passes that close code and reason on to `onclose` (it reported 1000 "Closed by remote" for every close).                                                                                                                                                                                                                                                                |
| rustls 0.23.29                                                 | `0051` | `crypto::ring::hpke`: HPKE (RFC 9180) base mode on ring, the sender's side, with the suites BoringSSL's ECH client offers (X25519, HKDF-SHA256, AES-128-GCM, AES-256-GCM, ChaCha20-Poly1305); only aws-lc-rs had HPKE, and it does not build for wasm32.                                                                                                                          |
| rustls 0.23.29                                                 | `0052` | Real ECH in a `chrome_hello`: `ClientConfig::set_ech_mode` (keeps TLS 1.2 in the outer hello, as Chrome does), BoringSSL's inner hello (TLS 1.3 only, no TLS 1.2 extensions, the differing extensions first and the rest as one `ech_outer_extensions` in the outer order, BoringSSL's padding), a rejecting server verified as the public name, `EchConfig::from_retry_configs`. |
| MercuryWorkshop/epoxy-tls                                      | `0056` | `ech_resolver` option: a DNS name's ECHConfigList, asked while the wisp stream opens; HTTP and WebSocket connections offer real ECH with it, retry once with a rejecting server's retry configs and connect without ECH when it sends none, as Chrome does.                                                                                                                       |
| MercuryWorkshop/EpoxyTransport                                 | `0052` | `ech_dns`: HTTPS records over DNS-over-HTTPS through the client, their `ech` handed to `ech_resolver` (kept for the TTL, at most 1.5 s of waiting per connection); `pem_files` passed through.                                                                                                                                                                                    |
| MercuryWorkshop/epoxy-tls                                      | `0057` | Writes go out as DATA packets of at most 64 KiB, each within the stream's CONTINUE credit (the transport flushed while it waits). A body was one packet, and holyWisp closes the connection past 262149 bytes (1009). A UDP datagram over it fails that send alone (EMSGSIZE, `send(datagram)`).                                                                                  |
| MercuryWorkshop/epoxy-tls                                      | `0058` | A UDP stream from `connect_udp` gets `closeReason()`: the wisp close reason it ended with, once its read side has ended. STomp's HTTP/3 tells a refused destination from a relay without UDP by it (docs/http3.md, rule 5); http3-fallback checks the reasons arrive.                                                                                                             |
| MercuryWorkshop/epoxy-tls                                      | `0061` | A WebSocket frame is flushed once written (`send`, `close`, the read loop's pong and close answers). fastwebsockets does not flush and the wisp stream only queued the packet for the sink's next poll, so the page's message left with its next frame or another stream's write.                                                                                                 |
| MercuryWorkshop/epoxy-tls                                      | `0062` | `EpoxyClient.partition()`: a client of its own HTTP pool and TLS session caches over the same wisp connection (the multiplexor and the one that replaces it are shared), for a network partition.                                                                                                                                                                                 |
| MercuryWorkshop/EpoxyTransport                                 | `0054` | `request` reads a request's network partition from the `$stomp$network` field (`fieldSupport.partition` names it), takes it off and sends the request on that partition's `partition()` client, as Chrome keys its socket pool by top-level site (STomp's `net-partitions` suite); idle 5 minutes, 64 kept.                                                                       |
| MercuryWorkshop/epoxy-tls                                      | `0063` | A response says which HTTP version it came over (`httpVersion`: `1.1`, `2`, ...). STomp's transport worker keeps six requests in flight to an HTTP/1 server and lets HTTP/2 ones go, as Chrome does (`connection-limits` suite).                                                                                                                                                  |
| MercuryWorkshop/EpoxyTransport                                 | `0055` | `request` passes that `httpVersion` on, and `fieldSupport.httpVersion` says it does.                                                                                                                                                                                                                                                                                              |
| rustls 0.23.29                                                 | `0053` | TLS 1.2 RSA key exchange (`KeyExchangeAlgorithm::RSA`, client only): the pre-master secret goes to the server encrypted by the config's `rsa_key_transport`, then the master secret (extended when agreed) as for ECDHE; no ServerKeyExchange, nothing signed; the signature check is keyed on the suite.                                                                         |
| rustls 0.23.29                                                 | `0054` | ServerHellos BoringSSL refuses are refused: a suite the hello did not offer, a non-empty renegotiation_info, a TLS 1.2 random ending in the TLS 1.1 downgrade sentinel or (with `chrome_hello`) JDK 11's.                                                                                                                                                                         |
| rustls 0.23.29                                                 | `0055` | A `chrome_hello` ignores the group it last agreed with a server name and always sends its first two key shares (X25519MLKEM768, X25519), as Chrome does.                                                                                                                                                                                                                          |
| MercuryWorkshop/epoxy-tls                                      | `0064` | Chrome's six TLS 1.2 suites rustls lacked (RSA and ECDHE_RSA AES-CBC-SHA, RSA AES-GCM); constant-time CBC opening as BoringSSL's; keyUsage checked as Chrome does. Carries Cargo.lock. rsa 0.9.10 is in RUSTSEC-2023-0071's range, which does not apply: the client only encrypts.                                                                                                |
| MercuryWorkshop/epoxy-tls                                      | `0065` | TLS sessions are kept as Chrome keeps them: by host and port, at most 1024 keys per network partition (least recently used out first), two TLS 1.3 tickets per key.                                                                                                                                                                                                               |
| MercuryWorkshop/epoxy-tls                                      | `0070` | The plain X25519 key share has a key of its own. X25519MLKEM768 handed rustls its own classical half as the X25519 share, so the last 32 bytes of one share equalled the other, where Chrome's two shares are separate keys. (stomp-h3's `src/mlkem.rs` likewise.)                                                                                                                |
| hyperium/hyper                                                 | `0051` | The HTTP/2 client adds no `Content-Length` for an empty body: it added `0` for every method with defined payload semantics, so Chrome's CORS preflight (an empty OPTIONS) went out with one. The caller says `0` where Chrome does.                                                                                                                                               |
| MercuryWorkshop/epoxy-tls                                      | `0071` | An empty request says `Content-Length: 0` only for POST and PUT, as Chrome's HttpNetworkTransaction does; an empty PATCH said it too.                                                                                                                                                                                                                                             |
| r58Playz/h2-wasm                                               | `0053` | A request's Cookie goes out as its crumbs, one field per cookie split at `;` (quiche's `HpackEncoder::CookieToCrumbs`, RFC 9113 8.2.3), in the Cookie field's place; it went out as one joined field. HTTP/1 keeps one line.                                                                                                                                                      |
| r58Playz/h2-wasm                                               | `0054` | HPACK as Chrome's encoder writes it: every field but the pseudo-headers other than `:authority` goes into the dynamic table (Content-Length and Cookie were left out, a `:method` the static table names only was put in), and a string is Huffman coded only when that is shorter.                                                                                               |
| MercuryWorkshop/epoxy-tls                                      | `0072` | RSA keys of every size Chrome 157 takes: 1024 to 16384 bits, counted exactly, at any place in the chain and under any root. _ring_ verifies 2048 to 8192 bits; RustCrypto `rsa` verifies the others, and RSA key exchange takes the same sizes. Carries a Cargo.lock line (sha2).                                                                                                 |
| hyperium/hyper                                                 | `0052` | `Error::is_empty_response()`: the request's connection ended before any byte of its response (HTTP/1: none read since its head was written; HTTP/2: GOAWAY or a closed connection before its head), and `Error::is_refused_stream()`: an HTTP/2 `REFUSED_STREAM` reset. A kept connection the server closed as a request reached it read as any other IncompleteMessage.          |
| r58Playz/hyper-util-wasm                                       | `0052` | `Error::is_reused_connection()`: a request that went out and then lost its connection says whether the pool had kept that connection (it came back as `SendRequest` with no record of it), and a response over a kept connection carries a `ReusedConnection` extension.                                                                                                          |
| MercuryWorkshop/epoxy-tls                                      | `0073` | A request goes again when Chrome sends it again (`ShouldResendRequest`): a kept connection that ended before any byte of a response, whatever the method; a 408 on a kept HTTP/1 connection; a refused HTTP/2 stream, twice at most. Not a fresh connection's, one whose response had begun, or a streaming body (`idle-close-retry` suite).                                      |
| MercuryWorkshop/epoxy-tls                                      | `0074` | A write of a Uint8Array or ArrayBuffer (a socket's chunk, a UDP datagram, a streamed request body's chunk) is taken as it is; each went through `new Request("", { body }).arrayBuffer()`, a Request, a promise and a task's wait, before every ACK an HTTP/3 connection sent. Anything else still goes through the Request.                                                      |
| MercuryWorkshop/epoxy-tls                                      | `0075` | client: a function transport's writes never wait, as the WebSocket's `send` does not. One that waited held wisp-mux's sink lock across a TLS handshake's lone flush, the actor stopped reading while it waited to send the next CONNECT, and every request on the connection hung (STomp's WebTransport carrier).                                                                 |
| MercuryWorkshop/epoxy-tls                                      | `0076` | A zstd body is decoded frame after frame to its end, as Chrome's `ZstdSourceStream` reads it (a skippable frame passed over); the decoder stopped at the end of the first frame and the rest was dropped, so Spotify's search answer, in 64 KiB frames, reached the page cut at 64 KiB (`zstd-frames` suite). Gzip still reads one member, as Chrome does.                        |
| ring 0.17.14 (the crates.io release Cargo.lock pins)           | `0001` | Its bitsliced AES (`aes_nohw.c`) takes 64-bit words, four blocks a batch, on wasm32 as on a 64-bit target, where it took 32-bit words, two blocks a batch: the same constant-time code, an HTTP/2 download over TLS about 40 % faster (AES-128-GCM was more than half of the transport worker's time). stomp-h3 vendors the same patch.                                           |
| MercuryWorkshop/epoxy-tls                                      | `0077` | `[patch.crates-io]` so ring comes from the sibling checkout.                                                                                                                                                                                                                                                                                                                      |
| MercuryWorkshop/epoxy-tls                                      | `0080` | `EpoxyClient.partition(ech_resolver)`: a partition may ask an ECH resolver of its own instead of the client's (Chrome keys its host cache, HTTPS records included, by the network partition). Without it, the client's, as before.                                                                                                                                                |
| MercuryWorkshop/epoxy-tls                                      | `0081` | An idle HTTP/1 connection is closed after 300 s and an idle HTTP/2 one kept until its server closes it, as Chrome 157 keeps them, with six idle to a host at most; hyper-util's pool closed either after 90 s.                                                                                                                                                                    |
| MercuryWorkshop/epoxy-tls                                      | `0082` | wisp: a stream's reads end after every packet it received before its CLOSE, in order, as a TCP stream ends after its data. They ended at the CLOSE, and what the stream held unread was dropped: a slow read of an HTTP/1.1 body cut short once the server closed its idle connection (`slow-body-close` suite).                                                                  |
| r58Playz/hyper-util-wasm                                       | `0053` | `Builder::pool_idle_timeout_http2(false)`: the idle timeout closes an idle HTTP/1 connection only, an HTTP/2 one staying until its server closes it (for epoxy-tls 0081). The default is as before.                                                                                                                                                                               |
| MercuryWorkshop/EpoxyTransport                                 | `0060` | `ech_dns` answers are kept per network partition and for their TTL, never longer (the records' smallest TTL, a NODATA's SOA negative TTL, nothing without one, a day at most); a failed lookup is asked again after 30 s. `ech_cache` (`load()`, `put()`) keeps them across a reload (STomp's `src/transport/echCache.ts`).                                                       |
| MercuryWorkshop/epoxy-tls                                      | `0078` | A response says when its connection was made and how many bytes its body came as: `connection` (`performance.now()`), `{ reused: true, requestStart }` over a kept connection, else `connectStart`, `secureStart`, `connectEnd`, `requestStart`, and `dnsStart`, `dnsEnd` for the ECH lookup; `encoded.bytes`, the body's bytes before decoding.                                  |
| MercuryWorkshop/EpoxyTransport                                 | `0056` | `request` passes them on: `connection` as ms from the call, `encodedBytes()` (not enumerable, so a cloned response drops it); `fieldSupport.timing` says a build has them.                                                                                                                                                                                                        |
| MercuryWorkshop/EpoxyTransport                                 | `0061` | `httpsAnswer(host, headers?)`: the DoH answer (wire format) to the name's HTTPS question in the request's partition, the one its ECH lookup reads; one question per name and partition serves both, a lookup out is shared, and the bytes go to `ech_cache` too.                                                                                                                  |

## stomp-h3 (`h3/`)

Our own crate, not an upstream patch: QUIC (quinn) and HTTP/3 (h3) for the
browser, over a datagram channel STomp hands in (epoxy's `connect_udp`, a
wisp UDP stream). It touches nothing in epoxy-tls or EpoxyTransport; the
Dockerfile builds it after them (`h3/build.sh`) into
`out/epoxy-transport/dist/h3/` (`stomp_h3.js`, `stomp_h3_bg.wasm`,
`stomp_h3.d.ts`), so it ships on the same `dist` branch and the demo serves
it as `/epoxy/h3/`. STomp's `Http3Transport` imports it only when `http3` is
on and an origin offers h3 (docs/http3.md).

- `Cargo.lock` is committed and the build is `--locked`; `wasm-bindgen` is
  pinned to `=0.2.100`, the CLI the image installs.
- `vendor.sh` fetches the crates it patches (h3 0.0.8), checks the crates.io
  checksum and applies `h3/patches/<crate>/*.patch` in order; `Cargo.toml`'s
  `[patch.crates-io]` points at `vendor/`. `h3/0001` writes request
  pseudo-headers in Chrome's order (`:method`, `:authority`, `:scheme`,
  `:path`); `h3/0002` sends Chrome's SETTINGS (order, QPACK values, a
  GREASE setting last with a random value) and its GREASE frame on the
  control stream, and no GREASE stream or request-stream GREASE; `h3/0003`
  decodes responses with the server's QPACK dynamic table (h3 0.0.8 only
  had the static table) and opens the QPACK streams in Chrome's order,
  typing them on first use; `h3/0004` sends a PRIORITY_UPDATE for each
  request with a Priority field, as Chrome does; `h3/0005` makes h3's QPACK
  decoder (with the dynamic table), static table and Huffman encoder
  reachable as a hidden `qpack_codec` module for the WebTransport client
  below. It also vendors rustls 0.23.29 with epoxy's own
  `patches/rustls` (`EPOXY_PATCHES`, `/patches` in the image), whose
  `chrome_hello` gives the QUIC ClientHello Chrome's shape (no GREASE,
  Chrome's QUIC extensions, ALPS for h3, a GREASE ECH), and quinn-proto
  0.11.19 with `h3/patches/quinn-proto/0001` (Chrome's client transport
  parameters: no min_ack_delay, a 65536 max_datagram_frame_size,
  version_information and google_connection_options) and `0002` (those
  two each in a random place, a random reserved version in random order
  next to version 1), and `0003` (ACKs decimated as Chrome's: every
  second ack-eliciting packet for the first 100, then every tenth or after
  a quarter of the minimum RTT, at most max_ack_delay, as quiche's
  QuicReceivedPacketManager), and `0004` (the keep-alive PINGs only while
  a bidirectional stream is open, as quiche's QuicPingManager: an idle
  connection sends nothing) and `0005` (a PING alone goes as Chrome's
  29-byte packet: no ACK frame unless one is due, and a client's packets
  padded only as far as header protection needs). It vendors
  ring 0.17.14 with
  epoxy's own `patches/ring/0001` (its bitsliced AES in 64-bit words on wasm32,
  four blocks a batch, as on a 64-bit target), and builds ring and the
  brotli and compression decoders at `opt-level = 3`, the rest for size.
  `src/lib.rs` adds
  X25519MLKEM768 (`src/mlkem.rs`, as in epoxy), brotli certificates, empty
  source connection ids, an 8-byte first destination id, no greased
  fixed bit, every Initial padded to 1250 bytes and no path MTU probes,
  a PING 15 s after the last packet heard while a request is open (counted
  in the connection's `pings`, which STomp's blackhole watch times), as
  Chrome's client, and seeds fastrand (h3's GREASE source, a fixed seed on
  wasm32-unknown-unknown otherwise). A request's fields go out in the
  caller's order, Accept-Encoding saying Chrome's `gzip, deflate, br, zstd`
  (in the caller's place, or before Accept-Language, Cookie and Priority
  when the caller has none) and a Cookie as its crumbs, one field per
  cookie, as Chrome's QPACK encoder sends it; a response body is decoded
  from gzip, deflate, br or zstd (every frame of a zstd body, as Chrome).
  A response's `encoded.bytes` counts its DATA bytes before that decoding
  (a page's `encodedBodySize`), the whole body's once the stream has ended,
  and a connection's `connectStart` and `connectEnd` say when `connect` was
  called and its handshake ended, in `performance.now()`, as epoxy's
  `connection` does over TCP.
- `connect_webtransport` (`src/wt.rs`) opens a WebTransport (draft 02)
  session as Chrome does, on a QUIC connection of its own with the same
  transport parameters and ClientHello as `connect` but no TLS session
  cache and a 15 s keep-alive. It drives quinn directly instead of h3's
  client (which refuses streams the server opens): Chrome's control stream
  (its SETTINGS with MAX_FIELD_SECTION_SIZE 16384, both H3_DATAGRAM
  settings and ENABLE_WEBTRANSPORT, a GREASE setting and frame), the QPACK
  stream ids skipped and left empty, no CONNECT before the server's
  SETTINGS take datagrams and WebTransport, the extended CONNECT with
  Chrome's fields in its order (Huffman only where shorter, as quiche
  decides) and the page's own `headers` (Chrome 157) last, as the caller
  hands them, a pseudo-header, a name that is no lower-case token and the
  fields it writes itself refused again, and a GREASE capsule, `:status 200` alone accepted, the `0x41`
  and `0x54` stream headers, quarter-stream-id datagrams,
  CLOSE_WEBTRANSPORT_SESSION both ways, and stream codes mapped to and from
  the HTTP/3 space. A session ends as Chrome's does: once both sides of
  the CONNECT stream are over, the data streams still open are stopped and
  reset with H3_CONNECT_ERROR (0x10f) in the packet with its FIN, and the
  connection goes quiet (no ACK and no CONNECTION_CLOSE after); a
  STOP_SENDING on the CONNECT stream is answered with RESET_STREAM and
  turns the close that follows into a lost session.
  `serverCertificateHashes` replaces WebPKI with `src/certhash.rs`
  (SHA-256 of the leaf, at most 14 days of validity that hold now, a
  P-256, P-384, Ed25519 or RSA key, the handshake signature checked).
- `out/UPSTREAM` ends with a `stomp-h3 <hash>` line naming the sources that
  went in.

To work on it without the whole image, run `h3/build.sh <out dir>` in a
container of the image `build.sh` tagged (it has the toolchain), copying the
crate in with `docker cp` (docker's filesystem here is not this machine's, so
bind mounts come up empty).

## Build

```sh
deploy/epoxy/build.sh          # docker or podman; 10 to 20 minutes
```

The container installs the Rust nightly, wasm32 target, `wasm-bindgen 0.2.100`
(epoxy's build script checks the exact version), binaryen and Node, clones the
four repos and h2-wasm at the pinned revisions, downloads the rustls crate (checked
against its checksum), applies the patches in numeric order and
runs epoxy-tls's `publish.sh` (full and minimal, `RELEASE=1`) followed by
EpoxyTransport's `npm run build`, then builds stomp-h3 into its `dist/h3/`.
Where docker's bridge network cannot reach the Rust and npm mirrors, set
`ENGINE` to a wrapper that adds `--network host` to `docker build`. Output:
`out/epoxy-tls` (the npm package layout) and `out/epoxy-transport` (with
`dist/`, `dist/h3/` included), plus `out/UPSTREAM` naming the revisions and
patches that went in.

## Test a build before publishing

The demo serves whatever `@mercuryworkshop/epoxy-transport` resolves to as
`/epoxy/`, so a checkout runs the suites against a build when that package
is the build's `out/epoxy-transport`. In a worktree whose `node_modules`
links into the main checkout's, make `node_modules` a real directory of
links and point only that package at the build, so the shared tree keeps its
pinned copy; then `npm test` as usual (`ws-handshake`, `epoxy-concurrency`,
`malformed-headers` exercise the patches).

## Publish and pin

```sh
deploy/epoxy/publish.sh        # pushes out/ to the dist branches, prints the sha
```

`Fracital/epoxy-tls` and `Fracital/EpoxyTransport` on GitHub hold only
distribution branches named `dist` with the built packages, so consumers run a
plain `npm ci` with no Rust toolchain. Pin the printed commit in
`package.json`:

```json
"@mercuryworkshop/epoxy-transport": "git+https://github.com/Fracital/EpoxyTransport.git#<sha>"
```

Use the `git+https://` form with a full commit sha. npm still writes
`git+ssh` into the lockfile for GitHub hosts and falls back to https when no
key is available, which is how CI and terp install it.

## Changing a patch

Clone the upstream at the pinned revision, `git am` the existing patches,
commit the change, then `git format-patch --no-cover-letter --no-signature
<rev>..HEAD -o patches/<repo>/` and rebuild. Keep one logical change per
patch and the subject line as the summary.
