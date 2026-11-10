# Network fingerprint: proxied requests vs the Chrome running them

A proxied page's requests leave the user's browser through a WASM TLS stack
(epoxy or libcurl) tunnelled over wisp, so the server sees that stack's
ClientHello, HTTP/2 framing and header order, not Chrome's, next to a
User-Agent that says Chrome. This page records what each transport
presented before and after the 2026-11 fingerprint work, measured against
the Chrome that ran the probe.

## How it was measured

- Chrome 152.0.7977.64 (Linux, headless, `--user-agent` set to the regular
  Chrome 152 UA so the service worker sends the same one), 2026-11-10.
- Echo services: `tls.peet.ws/api/all` (full ClientHello, JA3, JA4, peetprint,
  every HTTP/2 frame the client sent), `tls.browserleaks.com/json` (JA4, JA3n,
  Akamai), `tools.scrapfly.io/api/fp/anything` (JA4, JA3n, HTTP/2, headers).
- Each service loaded as a top-level navigation, then `fetch()` and XHR from
  inside `https://tls.peet.ws/` (same origin, so the response is readable).
- Targets: native Chrome; the local demo (`npm run demo`) in same-origin mode
  (`127.0.0.1`) and isolated mode (`localhost`, proxy origin `127.0.0.1`), each
  with epoxy and libcurl; the live https://stomp.fracit.al (Chrome launched
  with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE stomp.fracit.al,
EXCLUDE holywisp.fracit.al`).
- HTTP/1.1 (when h2 is not negotiated): a local recorder on plain HTTP that
  keeps the raw field names and order (`req.rawHeaders`), for a navigation,
  an iframe, a script, a module script, a stylesheet, an image, `fetch` (GET,
  POST, custom fields, `cache: no-cache | no-store | reload`), XHR, a form
  POST and a request with cookies.
- Chrome's HTTP/2 priorities per destination and its QUIC parameters come
  from its own NetLog (`--log-net-log --net-log-capture-mode=Everything`).
- JA4H is computed from the HEADERS frame peet.ws returns (method, version,
  cookie and referer flags, field count, first four of Accept-Language, then
  the SHA-256 of the field names in order).
- Probe scripts: `/tmp/fp-scripts/` (`probe.mjs`, `h1probe.mjs`, `summ.py`,
  `tlssweep.mjs`).

The two demo modes and the live site presented identical fingerprints for
each transport (only the JA3 hash differs between runs, because Chrome and
rustls both shuffle extension order per connection), so the tables show one
column per transport.

## Baseline (before)

| Field                          | Native Chrome 152                                                                                                                              | epoxy (rustls 0.23.29 + ring)                           | libcurl.js 0.7.5 (mbedTLS + nghttp2)                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| JA4                            | `t13d1517h2_8daaf6152771_cb7bf5808d99`                                                                                                         | `t13d1011h2_61a7ad8aa9b6_3fcd1a44f3e3`                  | `t13d10910h2_85781606486d_cf80c7f419ad`                                                |
| JA3n (scrapfly)                | `0ed47781e19fcbb7e1d0f32c371716a1`                                                                                                             | `3b5624332d78d95996926f2225108c34`                      | `af079031d16e5f8101b8d9775bd1a823`                                                     |
| JA3                            | random per connection (extension order is shuffled)                                                                                            | random per connection                                   | `18849fce1cc6aaad4b027f1d48a464e6` (fixed)                                             |
| peetprint                      | `fc97c1cdfb1409c9a9326c1b726d1dee`                                                                                                             | `1d1426cb11a5bb40062c771241c4543a`                      | `90d164d8513dc202ed3766f77b0a3dc8`                                                     |
| Cipher suites                  | GREASE, 1301 1302 1303 c02b c02f c02c c030 cca9 cca8 c013 c014 009c 009d 002f 0035                                                             | 1302 1301 1303 c02c c02b cca9 c030 c02f cca8, SCSV 00ff | 109 suites (CCM, CAMELLIA, ARIA, DHE, static ECDH...), SCSV 00ff                       |
| Extensions (excluding GREASE)  | 17, random order between a leading and a trailing GREASE                                                                                       | 11, random order, no GREASE                             | 10, fixed order, no GREASE, adds encrypt_then_mac                                      |
| Supported groups               | GREASE, X25519MLKEM768, X25519, P-256, P-384                                                                                                   | X25519, P-256, P-384                                    | X25519, P-256, P-384, X448, P-521, 26, 27, 28, ffdhe2048 to 8192                       |
| Key shares                     | GREASE (1 byte), X25519MLKEM768, X25519                                                                                                        | X25519                                                  | X25519                                                                                 |
| Signature algorithms           | GREASE, 0904 0905 0906 (ML-DSA), 0403 0804 0401 0503 0805 0501 0806 0601                                                                       | 0503 0403 0807 0806 0805 0804 0601 0501 0401            | 0403 0503 0603 0806 0805 0804 0601 0501 0401                                           |
| supported_versions             | GREASE, TLS 1.3, TLS 1.2                                                                                                                       | TLS 1.3, TLS 1.2                                        | TLS 1.3, TLS 1.2                                                                       |
| ALPN                           | h2, http/1.1                                                                                                                                   | h2, http/1.1                                            | h2, http/1.1                                                                           |
| Certificate compression        | brotli                                                                                                                                         | none                                                    | none                                                                                   |
| ALPS (application_settings)    | h2 (codepoint 17613)                                                                                                                           | none                                                    | none                                                                                   |
| ECH GREASE                     | yes (encrypted_client_hello, 250 bytes here)                                                                                                   | none                                                    | none                                                                                   |
| trust_anchors (0xca34)         | yes (204 bytes of Chrome Root Store ids)                                                                                                       | none                                                    | none                                                                                   |
| SCT, renegotiation_info        | both                                                                                                                                           | neither (SCSV instead)                                  | neither (SCSV instead)                                                                 |
| session_ticket, status_request | both                                                                                                                                           | both                                                    | neither                                                                                |
| record_size_limit, padding     | neither                                                                                                                                        | neither                                                 | neither                                                                                |
| PSK on resumption              | psk_dhe_ke offered, PSK last                                                                                                                   | same                                                    | psk modes offered, no tickets kept                                                     |
| HTTP/2 used                    | yes                                                                                                                                            | yes                                                     | yes                                                                                    |
| Akamai HTTP/2                  | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p`                                                                                         | `2:0;4:2097152;5:16384;6:262144\|5177345\|0\|m,s,a,p`   | `3:100;4:65536;2:0\|1048510465\|0\|m,s,a,p`                                            |
| Akamai hash                    | `52d84b11737d980aef856699f885ca86`                                                                                                             | `9e8b7734dfd8b21a1b2d23bf65e7872e`                      | `55cb2bd667724e6d46cc3c8dd15d50de`                                                     |
| HEADERS priority               | flag set, exclusive, weight by urgency (256 document, 220 fetch, 147 script and image), parent the newest stream of the same or higher urgency | none                                                    | none                                                                                   |
| PRIORITY frames                | none                                                                                                                                           | none                                                    | none                                                                                   |
| JA4H navigation                | `ge20nn13enus_0c2c1d640f3e`                                                                                                                    | `ge20nn12enus_0d40ebe41923`                             | `ge20nn12enus_9d2a9491d122`                                                            |
| JA4H fetch and XHR             | `ge20nr11enus_33778c32ea55`                                                                                                                    | `ge20nr10enus_c927edc21fa0`                             | `ge20nr10enus_646b523d6110`                                                            |
| Field order                    | per kind, see below                                                                                                                            | Accept-Encoding, then the rest alphabetically           | curl's (Host, Accept-Encoding), then the rest alphabetically                           |
| Accept-Encoding                | `gzip, deflate, br, zstd`                                                                                                                      | `gzip, br`                                              | `deflate, gzip, br`                                                                    |
| Priority field                 | `u=0, i` document, `u=1, i` fetch, `u=0` style, `i` image, none for a script                                                                   | none                                                    | none                                                                                   |
| HTTP/1.1 head                  | Host, Connection, Chrome's order, title case with `sec-ch-*` lowercase, no Priority                                                            | lowercase names, Accept-Encoding first, Host last       | Host, Accept-Encoding, `Upgrade: h2c`, `HTTP2-Settings` on plain http, Connection last |
| HTTP/3 and QUIC                | see below                                                                                                                                      | none (TCP only)                                         | none (TCP only)                                                                        |

The sec-ch-ua client hints, User-Agent and Accept-Language values were
already Chrome's: the service worker sends the browser's own.

### Chrome's field order

The order is the same over HTTP/1.1 and HTTP/2 (HTTP/1.1 puts Host and
Connection first; HTTP/2 has the pseudo-headers there).

- Document (top level or frame): `[Content-Length] [Pragma] [Cache-Control]`
  sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, Upgrade-Insecure-Requests,
  `[Content-Type]`, User-Agent, `[Origin]`, Accept, `[other client hints]`,
  Sec-Fetch-Site, Sec-Fetch-Mode, `[Sec-Fetch-User]`, Sec-Fetch-Dest,
  `[Referer]`, Accept-Encoding, Accept-Language, `[Cookie]`, priority.
- Subresource (script, style, image, fetch, XHR): `[Content-Length] [Pragma]
[Cache-Control] [Origin of a CORS GET an element starts: a module script,
a crossorigin image]` sec-ch-ua-platform, User-Agent, sec-ch-ua, `[the page's
fields]`, sec-ch-ua-mobile, Accept, `[Origin of a fetch or XHR, or of any
other method]`, Sec-Fetch-Site, Sec-Fetch-Mode,
  Sec-Fetch-Dest, `[Sec-Fetch-Storage-Access]`, Referer, Accept-Encoding,
  Accept-Language, `[Cookie]`, `[priority]`.
- Blink keeps a subresource's first group in a hash map, so the page's own
  fields land among the client hints in an order that depends on the whole
  set (`fetch` with Authorization, X-Foo, Content-Type and Accept gave
  sec-ch-ua-platform, Authorization, sec-ch-ua, X-Foo, sec-ch-ua-mobile,
  User-Agent, Accept, Content-Type).
- Cache modes: `no-cache` and a form POST add `Cache-Control: max-age=0`;
  `no-store` and `reload` add `Pragma: no-cache` and `Cache-Control: no-cache`.

### HTTP/3 and QUIC

Before the HTTP/3 work landed, neither transport spoke QUIC: native Chrome
vs proxied was h3 vs none. stomp-h3 (`deploy/epoxy/h3`, quinn + h3 +
rustls) now carries HTTP/3 over wisp UDP. Chrome 152's QUIC parameters come
from its NetLog (www.google.com); both QUIC ClientHellos were captured by a
local UDP server that decrypts the Initial packets (their keys derive from
the client's connection id, RFC 9001) and reassembles the CRYPTO stream
(`quiccap.mjs`, `h3hello.mjs`).

| Field                         | Native Chrome 152 over QUIC                                                                                                                                                                                                                                                                                                                                      | stomp-h3 before (rustls 0.23.46, quinn)                                                                                                                                                                                                                                           | stomp-h3 after                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| JA4 (QUIC)                    | `q13d0312h3_55b375c5d22e_178839b6cec1`                                                                                                                                                                                                                                                                                                                           | `q13d0311h3_55b375c5d22e_387675cfb458`                                                                                                                                                                                                                                            | `q13d0312h3_55b375c5d22e_178839b6cec1`                     |
| Cipher suites                 | 1301 1302 1303, no GREASE                                                                                                                                                                                                                                                                                                                                        | 1301 1302 1303                                                                                                                                                                                                                                                                    | same as Chrome                                             |
| Extensions                    | 12, random order, no GREASE: groups, ALPS (h3), SNI, supported_versions, compress_certificate (brotli), ALPN (h3), ECH GREASE, trust_anchors, psk_key_exchange_modes, key_share, quic_transport_parameters, signature_algorithms                                                                                                                                 | 11: psk modes, ALPN, groups, extended_master_secret, signature_algorithms, transport parameters, key_share, SNI, ec_point_formats, supported_versions, status_request                                                                                                             | Chrome's 12, random order (trust_anchors empty, see below) |
| Groups / key shares           | X25519MLKEM768, X25519, P-256, P-384 / X25519MLKEM768, X25519                                                                                                                                                                                                                                                                                                    | X25519, P-256, P-384 / X25519                                                                                                                                                                                                                                                     | same as Chrome                                             |
| Signature algorithms          | 0403 0804 0401 0503 0805 0501 0806 0601 0201                                                                                                                                                                                                                                                                                                                     | 0503 0403 0807 0806 0805 0804 0601 0501 0401                                                                                                                                                                                                                                      | same as Chrome                                             |
| Transport parameters          | version_information (1, GREASE version, 1), a GREASE parameter, initial_max_stream_data_* 6291456, google_connection_options `ORIG`, initial_max_data 15728640, max_udp_payload_size 1472, max_datagram_frame_size 65536, initial_max_streams_uni 103, max_idle_timeout 30000, initial_max_streams_bidi 100, an empty initial_source_connection_id; random order | the same windows, limits and idle timeout and a GREASE parameter, random order; also min_ack_delay, grease_quic_bit, active_connection_id_limit 5 and an 8-byte initial_source_connection_id; max_datagram_frame_size 65535; no version_information, no google_connection_options | the same 13 parameters with Chrome's values, random order  |
| First destination id, Initial | 8 bytes, first datagram 1250 bytes                                                                                                                                                                                                                                                                                                                               | 20 bytes, 1200 bytes                                                                                                                                                                                                                                                              | 8 bytes, 1200 bytes (quinn pads Initials to 1200)          |

Chrome's QUIC parameters and HTTP/3 settings (NetLog):

- QUIC version 1, transport parameters as above, plus
  `initial_round_trip_time` once Chrome has a cached RTT for the server.
- HTTP/3 SETTINGS: `SETTINGS_QPACK_MAX_TABLE_CAPACITY 65536`,
  `SETTINGS_QPACK_BLOCKED_STREAMS 100`, `SETTINGS_MAX_FIELD_SECTION_SIZE
262144`, `SETTINGS_H3_DATAGRAM 1`, plus one GREASE setting (a random
  reserved id and value per connection).
- Request fields: the same names in the same order as HTTP/2, with
  `:method :authority :scheme :path` and the Priority field; urgency changes
  later go out as PRIORITY_UPDATE frames.

## What changed

All epoxy changes are patches in `deploy/epoxy/patches` (numbered from 0050);
the stomp side is `src/server/headerOrder.ts` and `src/transport/serveTransport.ts`.

- TLS (rustls patch, `ClientConfig::chrome_hello`, epoxy-tls 0053): Chrome's
  cipher list and order, GREASE in the suites, extensions, groups, key share,
  versions and signature algorithms, SCT, renegotiation_info, ALPS for h2
  (and the client's EncryptedExtensions after the server's Finished when the
  server takes it, which BoringSSL servers require), a GREASE ECH shaped as
  BoringSSL's, Chrome's signature algorithm list, extension order random per
  connection between the two GREASE extensions. trust_anchors goes out with
  an empty list: with Chrome's 204 bytes of Chrome Root Store ids, Google's
  QUIC servers picked a chain for one of them that webpki-roots (Mozilla's
  store) could not verify (UnknownIssuer); empty, the extension still counts
  for JA4 and the server sends its default chain.
  X25519MLKEM768 with a separate X25519 share (ring's X25519 plus the pure
  Rust `ml-kem` crate, since rustls's hybrid needs aws-lc-rs, which does not
  build for wasm32-unknown-unknown). Brotli certificate decompression.
- HTTP/2 (h2-wasm 0050 to 0052, hyper-util-wasm 0050, epoxy-tls 0051):
  Chrome's SETTINGS values and order, connection window, pseudo-header order,
  HEADERS priority weight by urgency and Chrome's dependency tree.
- Fields (stomp `headerOrder.ts`): every request goes to the transport in
  Chrome's order for its kind, with Accept-Encoding, the Priority field
  (Chrome's per destination), Cache-Control/Pragma for the cache mode, and
  Origin on a module script. `serveTransport` keeps Accept-Encoding and
  Priority only for a transport that declares `fieldSupport` (our epoxy
  build); libcurl gets neither, so it sends its own Accept-Encoding and no
  Priority over HTTP/1.1.
- epoxy (epoxy-tls 0052, hyper 0050, hyper-util-wasm 0051): sends the fields
  in the caller's order, decodes deflate and zstd as well, title cases
  HTTP/1 names as Chrome does, starts an HTTP/1 head with Host and
  Connection, and drops Priority on HTTP/1.
- QUIC (stomp-h3, `deploy/epoxy/h3`): vendors rustls 0.23.29 with the same
  patch, whose `chrome_hello` gives a QUIC hello Chrome's QUIC shape (no
  GREASE, no TCP-only extensions, ALPS for h3, QUIC's signature algorithm
  list), plus X25519MLKEM768 and brotli certificates; quinn-proto 0.11.19
  with one patch for Chrome's client transport parameters; empty source
  connection ids, an 8-byte first destination id and no greased fixed bit.
  The http3 and http3-fallback suites pass with it (Google and YouTube over
  h3 included, which negotiate ALPS and need the client's
  EncryptedExtensions).

## After (epoxy)

Local demo, both modes; the live site runs the code that is deployed (the
baseline) until this lands and the epoxy pin is bumped.

| Field                | Native Chrome 152                      | epoxy before                           | epoxy after                                             |
| -------------------- | -------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| JA4                  | `t13d1517h2_8daaf6152771_cb7bf5808d99` | `t13d1011h2_61a7ad8aa9b6_3fcd1a44f3e3` | `t13d1517h2_8daaf6152771_cb7bf5808d99`                  |
| JA3n (scrapfly)      | `0ed47781e19fcbb7e1d0f32c371716a1`     | `3b5624332d78d95996926f2225108c34`     | `0ed47781e19fcbb7e1d0f32c371716a1`                      |
| peetprint            | `fc97c1cdfb1409c9a9326c1b726d1dee`     | `1d1426cb11a5bb40062c771241c4543a`     | `fc97c1cdfb1409c9a9326c1b726d1dee`                      |
| Akamai hash          | `52d84b11737d980aef856699f885ca86`     | `9e8b7734dfd8b21a1b2d23bf65e7872e`     | `52d84b11737d980aef856699f885ca86`                      |
| HEADERS priority     | weight 256, exclusive, parent 0        | none                                   | weight 256, exclusive, parent 0                         |
| JA4H navigation      | `ge20nn13enus_0c2c1d640f3e`            | `ge20nn12enus_0d40ebe41923`            | `ge20nn13enus_0c2c1d640f3e`                             |
| JA4H fetch and XHR   | `ge20nr11enus_33778c32ea55`            | `ge20nr10enus_c927edc21fa0`            | `ge20nr11enus_33778c32ea55`                             |
| HTTP/1.1 field order | Chrome's                               | see baseline                           | equal to native for every kind measured but two (below) |

Remaining HTTP/1.1 differences: a `fetch` with several fields of the page's
own puts them after sec-ch-ua instead of Blink's hash order (one
Content-Type alone is exact), and a field the page wrote in lowercase goes
out title cased (the service worker only sees lowercase names).

A sweep of 50 popular HTTPS sites through the demo (`tlssweep.mjs`) loaded
all 50 before and after; Stack Overflow and Quora now answer with the same
403 bot wall native Chrome gets from this machine, where rustls's hello
had been let through.

## After (libcurl)

libcurl.js takes no TLS or HTTP/2 options, so its ClientHello and SETTINGS
are unchanged (JA4 `t13d10910h2_85781606486d_cf80c7f419ad`, Akamai
`55cb2bd667724e6d46cc3c8dd15d50de`). Its fields now arrive in Chrome's
order; curl still puts its own Accept-Encoding (`deflate, gzip, br`) first,
and there is no Priority field (stomp sends it only to a transport that
keeps it off HTTP/1.1).

| Field              | Native Chrome 152           | libcurl before              | libcurl after               |
| ------------------ | --------------------------- | --------------------------- | --------------------------- |
| JA4H navigation    | `ge20nn13enus_0c2c1d640f3e` | `ge20nn12enus_9d2a9491d122` | `ge20nn12enus_20e23b3294a6` |
| JA4H fetch and XHR | `ge20nr11enus_33778c32ea55` | `ge20nr10enus_646b523d6110` | `ge20nr10enus_749a72b6b80a` |

Over HTTP/1.1 its head is Host, Accept-Encoding, then on plain http
`Upgrade: h2c` and `HTTP2-Settings` (Chrome never upgrades), then Chrome's
order, then `Connection: Upgrade, HTTP2-Settings` last.

## Chrome versions

The ClientHello is Chrome 152's whatever the UA says. The service worker
sends the browser's own User-Agent and client hints, so the hello matches
the UA when the user runs current stable Chrome. Against older Chrome the
differences are, from Chrome's release history (not measured here): before
131 the post-quantum group was X25519Kyber768Draft00 (0x6399) instead of
X25519MLKEM768; before 133 ALPS used codepoint 17513 instead of 17613; the
ML-DSA signature algorithms and trust_anchors are recent additions; before
110 extensions were not shuffled. JA4 does not see group codepoints, so the
first two do not change it; the ALPS codepoint and the extra extensions do.
Following the UA per request would need one ClientConfig per Chrome
release, chosen when a connection opens, and data on each release; it is
not done. Firefox and Safari users get Chrome's fingerprint and field order
next to their own UA.

## What is left

1. libcurl's TLS and HTTP/2 (the big one). libcurl.js ships a prebuilt
   wasm with mbedTLS and nghttp2 and takes no TLS or HTTP/2 options from
   JavaScript, so nothing short of a rebuild changes its ClientHello or
   SETTINGS. mbedTLS cannot send GREASE, ALPS, certificate compression or
   a hybrid post-quantum share, so the route is curl-impersonate's: BoringSSL
   at the revision Chrome 152 ships, plus curl-impersonate's curl patches
   (extension order and ALPS through BoringSSL, `CURLOPT_HTTP2_SETTINGS`,
   window update, pseudo-header order, stream weight, header order), built
   with emscripten. Plan, mirroring `deploy/epoxy`: `deploy/libcurl/` pins
   ading2210/libcurl.js, BoringSSL and the curl-impersonate patch set, a
   container runs the emscripten build (BoringSSL with `OPENSSL_NO_ASM`,
   curl `--with-openssl` against it, nghttp2 as now), patches libcurl.js's
   C glue to set the impersonation options and `CURL_HTTP_VERSION_2TLS`
   (which also ends the `Upgrade: h2c` on plain http), and publishes to a
   `dist` branch pinned like epoxy. Estimate: 3 to 5 days (BoringSSL under
   emscripten 1 to 2, porting curl-impersonate's patches to libcurl.js's
   curl and the glue 1 to 2, measuring and the suites 1), and about 1 MB
   more wasm. Not prototyped. Cheaper alternative: libcurl stays the
   WebSocket fallback it is in the tests, and HTTP goes through epoxy
   (the demo default), which also avoids libcurl's request-count hang.
2. Chrome's WebSocket ClientHello was not measured (no wss echo service);
   epoxy sends the same Chrome hello with ALPN `http/1.1` and no ALPS,
   which is what BoringSSL does without h2. Check with a TLS-terminating
   capture.
3. Following the UA's Chrome version (see above): one ClientConfig per
   release with that release's groups, ALPS codepoint and extensions,
   picked when a connection opens. About a day once the per-release data
   is measured; a Firefox profile (NSS's hello) is a larger version of the
   same.
4. A page's own fields in Blink's hash order: replicating WTF's HashMap
   iteration (its StringHasher and table sizes) would make multi-field
   `fetch` calls exact. About a day, fragile across Chrome releases.
5. QUIC leftovers: quinn pads Initial packets to 1200 bytes where Chrome
   sends 1250, and its GREASE transport parameter carries 0 to 15 random
   bytes where Chrome's carries one. Both are visible on the wire, neither
   is in JA4. A quinn-proto patch each (an hour).
6. trust_anchors goes out empty (see above). Sending Chrome's ids needs a
   verifier that trusts the Chrome Root Store anchors they name, not
   webpki-roots; until then a fingerprinter reading the extension body sees
   the difference, JA4 does not.
7. Out of reach here: the TCP/IP fingerprint (peet.ws `tcpip`) is the wisp
   server's (Linux), not the user's OS.
