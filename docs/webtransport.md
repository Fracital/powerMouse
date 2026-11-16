# WebTransport

`WebTransport` is, like WebRTC, a network API no service worker and no
transport sees: the browser's network service opens a QUIC connection of its
own to the server a page names, from the user's address. Through the proxy
that was a way around everything the proxy does (the user's address, the
page's emulated origin, its policy, the content blocker), and nothing hooked
it. A proxied page therefore never gets the browser's constructor. Its
`WebTransport` is a stand-in (`src/inject/modules/WebTransport.ts`) in every
realm that has the interface: documents and dedicated, shared and service
workers.

Sessions are not carried through the transport yet. Until they are (the
plan is the last section), a session of a proxied page ends as the
browser's own does when its server cannot be reached, and a page that falls
back to a WebSocket or to fetch, as pages written for WebTransport do,
falls back.

## What the browser does natively

Measured on Chrome 152.0.7977.64 and 156.0.8078.79 (and Chrome for Testing
153, 154 and 155 for what changed between them), with a page on
`http://127.0.0.1`, UDP ports that are closed, that only listen, and a
WebTransport server (quic-go's) on the machine.

- `new WebTransport('https://host:port/path')` is a QUIC handshake from the
  browser to `host:port` at once (a port that only listens hears four to
  six Initial packets in 4 s), from the page, from any worker, and from a
  frame's window whichever way the constructor is reached. No proxy
  setting of the page's is involved, and for an address literal neither is
  the resolver.
- The interfaces are `WebTransport`, `WebTransportBidirectionalStream`,
  `WebTransportDatagramDuplexStream` and `WebTransportError`, in secure
  contexts, in windows and in every kind of worker. There is no
  `WebTransportSendStream`, `WebTransportReceiveStream` or
  `WebTransportWriter`, and a session has no `getStats`, `draining`,
  `reliability` or `congestionControl`: its members are `ready`, `closed`,
  `protocol`, `datagrams`, `incomingBidirectionalStreams`,
  `incomingUnidirectionalStreams`, `close`, `createBidirectionalStream` and
  `createUnidirectionalStream`. A stream is a plain `ReadableStream` or
  `WritableStream`; `datagrams.readable` is a byte stream.
- The constructor reads two members of its options, `protocols` and then
  `serverCertificateHashes` (`allowPooling`, `requireUnreliable` and
  `congestionControl` are never read). The URL is parsed with no base, so a
  relative one is invalid.
- A server that cannot be reached (a closed port, a name that does not
  resolve, with a pinned certificate or without): `closed` rejects and then
  `ready`, in one task, with one `WebTransportError` whose message is
  "Opening handshake failed.", `source` `'session'`, `streamErrorCode`
  null, a few milliseconds after the constructor (4 s for a port that never
  answers). The same error then ends `datagrams.readable`,
  `datagrams.writable` (a datagram written before it waits for it) and the
  two streams of incoming streams.
- `close()` while the session connects rejects `closed` and `ready` with
  "close() is called while connecting."; after the session ended it does
  nothing.
- Chrome throttles a page's handshakes (`WebTransportThrottleContext`): a
  handshake waits 10 ms doubled for each handshake the page has pending
  (at most 60 s), times a random factor between 0.5 and 1.5; a handshake
  that failed, or was closed after it started, stays pending for five
  minutes; and with 64 pending a new session fails at once with
  "Connection lost.". Seventy sessions made together to a closed port: six
  end with "Connection lost.", and the others are tried at about 0, 10, 30,
  70, 150, 300, 600 ms and so on. One that is closed before its turn costs
  the next ones its wait and no more (ten of them, then a session: 94 to
  132 ms).
- Chrome 155 changed two things. `createBidirectionalStream()` and
  `createUnidirectionalStream()` on a session that is still connecting are
  kept (they reject with an InvalidStateError "The WebTransport connection
  is not open." when it fails) where 152 to 154 reject them at once with a
  NetworkError "No connection."; and `datagrams.incomingMaxAge` and
  `outgoingMaxAge` take any number that is not negative (0 for none,
  a RangeError otherwise) where 152 to 154 refuse a number that is not
  finite with a TypeError and ignore one that is not above zero.
- A session the page's `connect-src` refuses is made: `ready` and then
  `closed` reject with "Refused to connect to '<url>' because it violates
  the document's Content Security Policy", its streams stay as they were,
  and the page hears one `securitypolicyviolation`. A report-only policy
  reports and lets the session go on.

### On the wire

A session is a QUIC connection of its own (ALPN `h3`, the transport
parameters of Chrome's HTTP/3 connections, docs/http3.md), on which Chrome
speaks draft 02 of WebTransport over HTTP/3:

| What                   | Bytes                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| streams                | stream 2 is the control stream; 6 and 10, the QPACK streams, are never written; the first WebTransport unidirectional stream is 14                                                                                                                                                                            |
| SETTINGS               | in this order: QPACK_MAX_TABLE_CAPACITY 65536, MAX_FIELD_SECTION_SIZE 16384, QPACK_BLOCKED_STREAMS 100, H3_DATAGRAM (0x33) 1, the draft 04 H3_DATAGRAM (0xffd277) 1, ENABLE_WEBTRANSPORT (0x2b603742) 1, one GREASE setting; then one GREASE frame of 0 to 3 bytes                                            |
| what it waits for      | the server's SETTINGS with H3_DATAGRAM 1 and ENABLE_WEBTRANSPORT 1 (without either, or with only the later drafts' settings, no request is sent and the session fails); ENABLE_CONNECT_PROTOCOL is not needed                                                                                                 |
| the request            | HEADERS on stream 0, static table and literals only, fields in this order: `:scheme https`, `:method CONNECT`, `:authority`, `:path`, `:protocol webtransport`, `sec-webtransport-http3-draft02: 1`, `origin`, and `wt-available-protocols: "a", "b"` for `protocols`. No user-agent, no cookie, nothing else |
| after the request      | a DATA frame with one GREASE capsule                                                                                                                                                                                                                                                                          |
| the answer             | `:status 200` and nothing more is a session; 204, 302, 403 and 404 fail it as an unreachable server does                                                                                                                                                                                                      |
| a datagram             | a QUIC DATAGRAM frame: the session's quarter stream id (`00`), then the bytes                                                                                                                                                                                                                                 |
| a stream of the page   | bidirectional: `40 41` (0x41 as a two-byte varint), the session id, then the bytes; unidirectional: `40 54`, the session id, then the bytes                                                                                                                                                                   |
| `close({ 42, 'bye' })` | a DATA frame on stream 0 with the capsule 0x2843 (CLOSE_WEBTRANSPORT_SESSION): the code in four bytes, the reason; then FIN                                                                                                                                                                                   |

`datagrams.maxDatagramSize` is 1024 before a session is ready; after, 152
still reads 1024 and 156 reads 1215 (against the same server).

## The stand-in

The page's `WebTransport` is the browser's function wrapped
(`ProxyModule.wrapFunction`, as every constructor the proxy stands in for):
its name, length and source are the browser's, a call without `new` or
without an argument gets the browser's own error from the browser's own
function, and its `prototype` is the browser's object, whose `constructor`
is the stand-in, so the constructor is reached the same whichever way a
page gets to it (`Reflect.construct` with or without a new.target, the
prototype's `constructor`, another session's, a subclass, a bound function)
and in whichever realm: every document and worker the inject covers
installs it before the page's first script, and a frame's first window, an
`about:blank` or `srcdoc` document and a popup get their creator's.

A session is an ordinary object on that prototype (the new.target's, so a
subclass's instance is the subclass's). The prototype's members are the
browser's functions wrapped: for a session of the proxy's they answer from
it, and for anything else they run as they are, so a member called on
something that is no session fails in the browser's own words. The same
holds for `WebTransportDatagramDuplexStream.prototype`, and for the
`source` getter of `WebTransportError.prototype`: the errors a session ends
with are the browser's own `WebTransportError`s (a page can only construct
ones whose source is `'stream'`), marked as a session's.

What a frame pays: the wrapper around the constructor, and the browser
making the `WebTransport` interface for it (about 2 KB of heap a frame,
frame-cost). The prototypes are wrapped, the other three interfaces looked
at, the tables and the throttle made when a realm makes its first session.
The code is in the inject bundles (7 KB of `injectDocument.js`): a page
may call a session's members in the statement after it made it, so none of
it can be a file fetched when a session is first made without a synchronous
request for it.

### What it answers

- The constructor's arguments, in Chrome's order and words: the URL
  converted to a string (a symbol, a `toString` that throws), the options
  dictionary (`protocols` read before `serverCertificateHashes`, each a
  sequence read through the page's iterator once, each hash's `algorithm`
  and `value`), then the URL (invalid, not https, a fragment), then the
  page's policy, then the protocol names (empty, a character outside
  printable ASCII, 512 characters or more, a duplicate).
- A session ends as one whose server cannot be reached: when Chrome's
  throttle would have started its handshake (the model above, one for the
  bundle), `closed` and `ready` reject and the four streams end, in
  Chrome's order, with "Opening handshake failed."; past 64 pending, with
  "Connection lost.". `ready` and `closed` are made when the page first
  reads them, as the browser's are, so one nobody read is no unhandled
  rejection.
- `close()`, `createBidirectionalStream()`, `createUnidirectionalStream()`
  and the numbers of `datagrams` as measured, by the browser's version
  (the two things Chrome 155 changed are told from the user agent's
  version, there being no session of the browser's to ask).
- The page's `connect-src`, in a document: a session it refuses ends as
  natively, and the browser reports the refusal itself (through a request
  the browser's copy of the policy refuses, `DocumentClient.connectRefusal`,
  as a synchronous XMLHttpRequest's is reported); a report-only policy's
  report is the inject's own event (docs/csp.md).

Mixed content does not come into it (the URL must be https, and the
interface exists only in secure contexts). A session a content blocker
refuses ends natively as one whose server cannot be reached: Chrome for
Testing 155 with a `declarativeNetRequest` block rule, one for the type
`webtransport` and one with no type alike, rejects `closed` and then `ready`
with "Opening handshake failed." 3 to 5 ms after the constructor, and
nothing is sent. Since no session of the stand-in connects, a session the
lists would refuse already ends that way; the lists are not asked
(docs/adblock.md) and have to be once sessions connect (item 5 below).

### Where it differs from the browser's

- No session connects yet (below).
- `structuredClone(session)` (and a `postMessage` of one) copies an empty
  object where the browser throws a DataCloneError: a session is an
  ordinary object. The suite tells this difference apart.
- A member of one document's prototype called on a session another
  document made works only when both run one inject bundle (a frame's
  first window, `about:blank` and `srcdoc` children) or that realm has
  made a session too; the browser checks what the object is, whichever
  realm's function is called.
- The throttle is one per inject bundle (a document and the windows it
  made), where Chrome's is one per page, shared by its frames; and it does
  not know servers by their addresses, which Chrome 152 to 156 do not use
  either (every failure is the five minutes).
- A worker's sessions are not judged by a policy: the inject knows a
  document's `connect-src` only, as for a WebSocket.
- A page on an http origin has `WebTransport` through a proxy origin that
  is a secure context, as it has every other interface of secure contexts;
  natively it has none.
- A page that replaced `Promise`, `ReadableStream`, `WritableStream` or
  `DOMException` on its window before it made its first session has its
  own used for that session's objects, where the browser's are its own.

## Not built: a session over wisp

A session has to travel as the page's requests do: QUIC datagrams on a
wisp UDP stream (epoxy's `connect_udp`), from the transport worker, through
stomp-h3 (`deploy/epoxy/h3`), which already makes Chrome's QUIC and TLS
handshake there for HTTP/3. What that takes, in the order to build it:

1. **stomp-h3: a WebTransport client** (`connect_webtransport(url,
readable, writable, options)` beside `connect`), on a connection of its
   own per session, as Chrome's:
   - the SETTINGS of the table above (the fetch connection's with
     MAX_FIELD_SECTION_SIZE 16384, the draft 04 datagram setting and
     ENABLE_WEBTRANSPORT added; `h3/patches/h3/0002` writes the fetch
     ones), and waiting for the server's with H3_DATAGRAM and
     ENABLE_WEBTRANSPORT before the request;
   - the extended CONNECT with Chrome's fields in Chrome's order (`:scheme`
     first, which differs from the fetch order of `h3/patches/h3/0001`),
     `origin` the page's real origin, no cookie; the GREASE capsule after
     it; `:status 200` and nothing else accepted; `wt-protocol` read for
     `protocol`;
   - streams: the `0x41` and `0x54` prefixes with the session id on the
     ones the page opens, and the server's (h3 0.0.8 keeps incoming
     `0x54` streams in `accepted_streams.wt_uni_streams` when
     `enable_webtransport` is set, and its client refuses a bidirectional
     stream the server opens: that needs a patch or a wrapper of the quic
     traits that takes those streams before h3 sees them);
   - datagrams with the quarter stream id (quinn's `send_datagram` and
     `read_datagram`; the connection already advertises
     `max_datagram_frame_size`), and the size Chrome reports as
     `maxDatagramSize`;
   - capsules on the CONNECT stream: CLOSE_WEBTRANSPORT_SESSION (0x2843)
     both ways, a FIN without one as code 0, DRAIN and unknown ones
     skipped;
   - the stream error codes (`0x52e4a40fa8db + n + n / 0x1e`) for
     RESET_STREAM and STOP_SENDING both ways, and
     WEBTRANSPORT_SESSION_GONE (0x170d7b68) for a session's streams when
     it ends;
   - `serverCertificateHashes`: a rustls verifier in place of the WebPKI
     one that does what Chrome's does (the SHA-256 of the leaf is one of
     the hashes, a validity period of at most 14 days that holds now, a
     key type Chrome allows there, the handshake signature still checked,
     no name and no chain).
     The build and its publication follow deploy/epoxy/README.md.
2. **The transport worker**: a `webtransport` call beside `udp` and `tcp`
   (`src/transport/messages.ts`, `serveTransport.ts`) that opens the UDP
   stream, loads stomp-h3 as `Http3Transport` does and serves one session
   on a port: a message for each datagram, and a port for each stream with
   credit both ways (a chunk written is acknowledged when QUIC took it,
   which is the page's `writer.ready`; a chunk read is asked for by the
   page's stream), buffers transferred, never copied. With a transport
   that has no UDP (libcurl) a session ends as it does today.
3. **The page**: the session object of this module with its streams fed
   from that port instead of ending (`WebTransportBidirectionalStream`'s
   two getters wrapped the same way), the throttle fed by what the
   handshakes did, and that part of the code in an asset of its own,
   loaded when a session is first made (nothing of it is needed before the
   first task).
4. **A server for the suite**: the measurements here used a server built
   on quic-go's webtransport-go (echo on streams and datagrams, streams of
   its own, a close code, resets, a slow reader, a refusal), which no
   suite can build today (the repository builds nothing in Go and has no
   QUIC origin of its own); the suite needs that server, or one made from
   stomp-h3's own stack, checked in with a way to build it. Natively
   Chrome takes that server's certificate only with a pinned hash, or with
   both `--ignore-certificate-errors-spki-list` and
   `--origin-to-force-quic-on` for its address.
5. **The content blocker**: the transport host asks the engine before it
   opens the UDP stream, as it does for a WebSocket's handshake
   (docs/adblock.md), with the session's https URL and the page's real
   origin, and a refused session ends as above (3 to 5 ms, "Opening
   handshake failed.", nothing sent). The type the engine is asked with
   has to be checked against adblock-rust's request types (Chrome's
   blocker has `webtransport`; a rule with no type applies to it).
6. **Policy in workers**: a worker's `connect-src` is not known to the
   inject today (as for a WebSocket); once sessions connect that becomes a
   way past a worker's policy, so it lands with the same fix as the
   WebSocket's or before this.

## Tests

`webtransport` (no network): a UDP socket of the suite's hears what is sent
to it. Natively a session from each of 27 ways to a constructor is a
handshake it hears (the control; a way this Chrome does not open, a `data:`
frame for one, is noted and left out). Through the proxy, in both demo
modes, it hears nothing from any of them, and each session ends as one
whose server cannot be reached. Then every answer of the stand-in is
compared with the browser's own on the same page, in the page and in a
dedicated, a shared and a service worker: the shapes of the constructor and
the prototypes before and after a session is made, the constructor's
answers to some eighty arguments and the order it reads its options in, a
session to a closed port (used before, during and after it fails), to a
name that does not resolve and with a pinned hash, `close()` while
connecting, the datagram numbers and what they take, every member on
something that is no session, the page's own `WebTransportError`, unhandled
rejections, seventy sessions at once, and a session the page's `connect-src`
refuses, enforced and report-only. On a build without the stand-in the
suite fails at every way: the server hears the browser.
