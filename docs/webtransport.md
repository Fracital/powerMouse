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

Its sessions travel as the page's requests do: the transport carries them
as QUIC on a wisp UDP stream (stomp-h3's WebTransport client), and the
page's streams, datagrams, closes and errors read as the browser's own
(the last sections). A transport that cannot carry one (no UDP, a stomp-h3
without the client) ends a session as the browser's own ends when its
server cannot be reached, and a page that falls back to a WebSocket or to
fetch, as pages written for WebTransport do, falls back.

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
- Chrome 157 (157.0.8103.50) reads a third, `headers`, first: a
  `(record<ByteString, ByteString> or sequence<sequence<ByteString>>)`
  (an iterable is pairs, anything else its own enumerable keys; null, a
  number or a string is refused, and so is a character past U+00FF). After
  the URL and the protocols the constructor refuses, with a TypeError, a
  pair that is not two ("Invalid value"), a name that is no token
  ("Invalid name") and a value with a NUL, CR or LF once its leading and
  trailing whitespace is cut ("Invalid value"), pair by pair, and then
  `wt-available-protocols` ("The 'wt-available-protocols' header cannot be
  set."). Fetch's forbidden request headers, `user-agent`, `sec-` and
  `proxy-` names, and a method override that names CONNECT, TRACE or TRACK
  are left out without a word. The rest go on the CONNECT after
  `wt-available-protocols`, in lower case and sorted by name (the page's
  order within one name), their values trimmed; a value of Latin-1 bytes
  goes as those bytes. (Measured with a server of our own, which logs the
  fields, and quic-go's for the Latin-1 bytes our server refuses.)
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

### A live session

Measured the same way against a WebTransport server on the machine
(webtransport-go's, and the suite's, test/wtserver.mjs):

- A stream's readable, an incoming unidirectional stream and
  `datagrams.readable` are byte streams (a BYOB reader works; a view too
  short for a datagram errors the readable with a RangeError "supplied view
  is not large enough."). Chunks are exact Uint8Arrays at offset 0, as the
  network split them, up to about 64 KiB. A writable's high-water mark is
  one chunk, and a write resolves once QUIC took it; written buffers are not
  detached.
- A write of something that is no buffer errors the writable with a
  TypeError and tells the server nothing. A datagram larger than the
  connection takes is dropped and its write still resolves.
- The incoming datagrams nobody reads keep the newest
  `incomingHighWaterMark`.
- The request carries the page's origin and nothing else of the page's: no
  cookie, no user agent, from a document and from workers alike. A 403 or a
  404 fails the session with "Opening handshake failed.".
- `close({ closeCode, reason })` fulfills `closed` at once with what the
  page gave (the code wrapped to 32 bits, the reason made well formed; the
  wire carries at most 1024 bytes of it), after every open stream and the
  datagrams' streams rejected with "The session is closed." (source
  `'session'`); the two streams of incoming streams end as done. The
  server's close capsule does the same with the server's code and reason; a
  FIN without one is `{ closeCode: 0, reason: '' }`; a STOP_SENDING or a
  reset of the CONNECT stream with it (webtransport-go's own close), or the
  connection lost, rejects everything with "Connection lost.".
- A peer's RESET_STREAM rejects the read with "Received RESET_STREAM." and
  its STOP_SENDING the writable (whether or not a write waits) with
  "Received STOP_SENDING.", both with `streamErrorCode` the peer's
  WebTransport code (0 for one that is not, as the WEBTRANSPORT_SESSION_GONE
  a server's close resets its streams with). The page's `cancel(reason)`
  and `abort(reason)` send the code of a `WebTransportError` of the
  browser's own making (its constructor takes 0 to 255), 0 for anything
  else.
- A session is open until it is closed: Chrome's keep-alive holds an idle
  one past the server's idle timeout.

### What a server's answer and close draw from Chrome 157

Measured on Chrome 157.0.8103.50 headless against test/wtserver.mjs (its
`resp`, `wtp` and `observe` parameters), each case twice, a page on
`http://127.0.0.1` pinning the server's hash. What a server written for
Wisp over WebTransport (holyWisp's listener) may send and what it hears back:

- Chrome reads nothing of the 200 but `:status` and `wt-protocol`. A
  `sec-webtransport-http3-draft` field (`draft02`, `draft03`, `foo`, `1`,
  empty, or two of them) is neither needed nor checked: the session is
  ready and its streams and datagrams work with any of them or none.
- `wt-protocol` sets `protocol` only when it is one structured-field string
  that is one of the page's `protocols` (any of them, not only the first; a
  parameter after it, `"a";q=1`, is taken and dropped). Anything else is
  ignored and leaves `protocol` `''` with the session up: a string the page
  did not offer, a bare token (`echo-v1` without quotes), a list of two
  offered strings, two `wt-protocol` fields, one sent when the page offered
  none. A server that echoes the first token offered (`"wisp-v2"` for
  `['wisp-v2', 'other']`) gets `protocol` `'wisp-v2'`.
- After the server's CLOSE_WEBTRANSPORT_SESSION capsule and FIN on the
  CONNECT stream, Chrome answers within a millisecond on loopback with a
  FIN of its own on the CONNECT stream and nothing else on it: no capsule,
  no RESET_STREAM, no STOP_SENDING, and it acknowledges the server's capsule
  and FIN. Each stream the page had open is reset by Chrome with the HTTP/3
  code 0x10f (H3_CONNECT_ERROR, no WebTransport code), a bidirectional one
  and a unidirectional one alike. The page's `closed` fulfills with the
  server's code and reason, and its writables reject with "The session is
  closed." (source `'session'`). A close sent right behind the 200 lands
  before the page's first `createBidirectionalStream()`, which rejects with
  "The WebTransport connection is not open.".
- With webtransport-go's close (`style=gone`: the data streams stopped and
  reset with WEBTRANSPORT_SESSION_GONE, and the CONNECT stream stopped,
  then the capsule and FIN), the page reads "Connection lost." where it
  read the code and reason, its bidirectional writer "The stream was
  aborted by the remote server" and its unidirectional one "Received
  STOP_SENDING." (code 0), and Chrome never acknowledges the capsule (the
  server's send side ends with the connection).
- Chrome never sends CONNECTION_CLOSE after a session ends, whether the
  page stays open or its tab is closed 2 s later: it sends nothing more on
  the connection (no PING either, where a live session is kept alive) and
  leaves it to the server's idle timeout (quinn's 30 s, counted from the
  close). A server has to reap such connections itself, at once after the
  CONNECT stream's FIN if it allows one session per connection.

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
frame-cost). Everything else is made when a realm makes its first session:
the stand-in (`src/inject/webTransportStandIn.ts`) and what carries its
sessions (`src/inject/webTransport.ts`) are deferred parts of the document
bundle (`src/inject/dom/deferred.ts`, the last statement of
`dist/rewriterLib.js`), evaluated synchronously then, from the top's copy
with no request, so the constructor still answers in the statement that
called it; the prototypes are wrapped, the other three interfaces looked
at, the tables and the throttle made then too. What the bundle keeps is the
wrapper and the few natives the stand-in takes before any page script ran.
The worker bundle has both parts as its own code.

### What it answers

- The constructor's arguments, in Chrome's order and words: the URL
  converted to a string (a symbol, a `toString` that throws), the options
  dictionary (`headers` where the realm's own constructor reads it,
  `protocols` read before `serverCertificateHashes`, each a sequence read
  through the page's iterator once, each hash's `algorithm` and `value`),
  then the URL (invalid, not https, a fragment), then the page's policy,
  then the protocol names (empty, a character outside printable ASCII, 512
  characters or more, a duplicate), then the headers as Chrome 157 checks
  them. Whether the realm's constructor reads `headers` is asked of it once,
  with a URL it refuses after reading its options, so nothing is opened.
  The headers Chrome would send go with the session's handshake.
- A session's handshake starts when Chrome's throttle would have started
  it (the model above, one for the bundle; a handshake that failed keeps
  its place five minutes, one that came up gives it back). One that fails
  (no answer in 4 s, a refusal, a certificate that is not taken) rejects
  `closed` and `ready` and ends the four streams, in Chrome's order, with
  "Opening handshake failed."; past 64 pending, with "Connection lost.". `ready` and `closed` are made when the page first
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
- The worker's own `connect-src`, in a worker (its script's response's,
  or its creator's for a `blob:` or `data:` worker): a session it refuses
  ends as natively, and the worker reports every refusal itself, on its
  global, read as trusted (`WorkerClient.connectVerdict`, docs/csp.md).

Mixed content does not come into it (the URL must be https, and the
interface exists only in secure contexts). A session a content blocker
refuses ends natively as one whose server cannot be reached: Chrome for
Testing 155 with a `declarativeNetRequest` block rule, one for the type
`webtransport` and one with no type alike, rejects `closed` and then `ready`
with "Opening handshake failed." 3 to 5 ms after the constructor, and
nothing is sent. The proxy's blocker refuses a session the same way, before
anything is opened (below).

### Where it differs from the browser's

- A session to a closed port fails when the wisp server reports the port
  unreachable: within a few milliseconds of the browser's with a holyWisp
  that closes the UDP stream on either side's ECONNREFUSED. holyWisp 0.5.2
  and before drop the error when a send collects it before a read does, and
  a QUIC Initial goes out two datagrams at a time, so there the stream closes
  on a later retransmit (0.3 s, 0.9 s, 2.1 s) or never, and the session fails
  when the handshake gives up after 4 s.
- Chrome keeps up to 6 MiB of a stream the page does not read; the
  transport reads 256 KiB ahead of the page's reader, and the rest waits in
  stomp-h3's QUIC window.
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
- A page on an http origin has `WebTransport` through a proxy origin that
  is a secure context, as it has every other interface of secure contexts;
  natively it has none.
- A page that replaced `Promise`, `ReadableStream`, `WritableStream` or
  `DOMException` on its window before it made its first session has its
  own used for that session's objects, where the browser's are its own.

## Sessions over wisp

A session travels as the page's requests do: QUIC datagrams on a wisp UDP
stream (epoxy's `connect_udp`), from the transport worker, through
stomp-h3's WebTransport client (`deploy/epoxy/h3`, `connect_webtransport`),
on a QUIC connection of its own per session, as Chrome's. Nothing of it runs
before a page makes a session:

1. **The page** (`src/inject/webTransportStandIn.ts`): when Chrome's
   throttle would start a session's handshake, the realm hands it to what
   carries it (`src/inject/webTransport.ts`), a deferred part in a
   document, evaluated with the realm's first session.
2. **What carries it** asks the transport (`webtransport`, on the realm's
   transport port, or its parent's or opener's for a frame's first window
   or a popup with no service worker yet; `src/transport/messages.ts`) for
   a session on a MessagePort of its own, with the URL, the page's real
   origin, its protocols and its pinned hashes. Once it is up the
   session's `ready` fulfills, `protocol` is the server's, and on Chrome
   155 on `maxDatagramSize` is the connection's. Its streams are the
   realm's own `ReadableStream` (bytes, as natively) and `WritableStream`
   (a high-water mark of one chunk): what arrives is in the page's stream
   as it arrives, up to 256 KiB ahead of its reader, each chunk the page
   writes is answered once QUIC took it, so QUIC's flow control is the
   page's backpressure both ways, and every buffer is transferred.
   `WebTransportBidirectionalStream`'s two getters are wrapped as the
   session's members are. A session ends in Chrome's order: the datagrams'
   streams, the streams' readables, their writables, `closed`, the two
   streams of incoming streams.
3. **The transport worker** (`src/transport/webTransportHost.ts`) imports
   stomp-h3 from where HTTP/3 loads it (the descriptor's `http3.module`, or
   epoxy's `h3/stomp_h3.js`, whether or not HTTP/3 is on) and looks for its
   WebTransport client among the exports before the wasm is instantiated,
   asks the controller whether the session may be made (the content
   blocker, below), opens the UDP stream and serves the session on the
   port. The roots a
   certificate may chain to besides the WebPKI's are the ones the host gave
   epoxy (`pem_files`) and the HTTP/3 option's.
4. **stomp-h3** speaks Chrome's draft 02 as in the table above: the
   SETTINGS, the extended CONNECT with Chrome's fields in Chrome's order and
   the page's origin (no cookie, no user agent) and on Chrome 157 the
   page's own headers as the realm checked them (stomp-h3 refuses a
   pseudo-header, a name that is no lower-case token and the fields it
   writes itself again), the GREASE capsule, only
   `:status 200` taken, the stream prefixes, HTTP/3 datagrams with the
   quarter stream id, the close capsule both ways, the stream error codes,
   and `serverCertificateHashes` checked as Chrome checks them (the leaf's
   SHA-256, a validity of at most 14 days that holds now, no name and no
   chain). Its build and publication follow deploy/epoxy/README.md.
5. **The content blocker**: the transport asks the controller, which asks
   the engine as for a WebSocket's handshake (docs/adblock.md), with the
   session's URL and the page's real origin, as a request of the type
   `other` (adblock-rust has no `webtransport` type; Chrome's blocker
   does, and a rule with no type applies to both). A refused session ends
   as natively (3 to 5 ms, "Opening handshake failed.") and nothing is
   sent.

A transport without stomp-h3 or without UDP (libcurl) and a stomp-h3
without the client (an epoxy-transport released before it had one) end
every session as the stand-in alone does: "Opening handshake failed." when
Chrome's throttle would have started it, before the blocker is asked or a
stream is opened, so nothing is sent. A wisp server that refuses UDP ends it
the same way once it refuses the stream.

## Tests

`webtransport` (no network): a UDP socket of the suite's hears what is sent
to it, and test/sockets.mjs tells whose socket sent each datagram.
Natively a session from each of 27 ways to a constructor is a handshake it
hears (the control; a way this Chrome does not open, a `data:` frame for
one, is noted and left out). Through the proxy, in both demo modes, it
hears nothing from the browser from any of them: what it hears is the wisp
server's, and each session reads as the browser's does to a server that
never answers. Then every answer of the stand-in is compared with the
browser's own on the same page, in the page and in a dedicated, a shared
and a service worker: the shapes of the constructor and the prototypes
before and after a session is made, the constructor's answers to some
eighty arguments and the order it reads its options in, a session to a
closed port (used before, during and after it fails), to a name that does
not resolve and with a pinned hash, `close()` while connecting, the
datagram numbers and what they take, every member on something that is no
session, the page's own `WebTransportError`, unhandled rejections, seventy
sessions at once, and a session the page's `connect-src` refuses, enforced
and report-only, and when each session to a closed port fails, against the
browser's (at most 50 ms later). On a build without the stand-in the suite
fails at every way: the server hears the browser.

Two things outside STomp change what it holds the stand-in to
(test/webtransport-env.mjs). With a stomp-h3 that has no WebTransport client,
every session must fail as one whose server cannot be reached with nothing
reaching the server, as the stand-in alone does; webtransport-live then
skips, saying why. With a wisp server that reports a closed UDP port late
(the suite asks the demo's own: six UDP streams to a closed port, two
datagrams each, each closed within 100 ms or not), sessions to a closed port
are compared by how they end, not by what the page saw while they waited,
and how late each failed is listed.

`webtransport-live` (no network): the suite's WebTransport server
(test/wtserver.mjs, a Rust crate built to wasm and run on node:dgram; its
outputs are checked in and rebuild byte for byte with
test/wtserver/build.sh) is the far end for the same page natively and
proxied, in both demo modes, and every answer is compared, with what the
server saw of each session (its request's fields and SETTINGS, how each
stream ended): a bidirectional stream echoed (every kind of buffer, a
large write, its end), the server's own streams and its CONNECT request,
a unidirectional stream each way, datagrams (echo, the numbers, one too
large, one that is no buffer), a close by the page and two by the server
(its capsule; and webtransport-go's, which resets the streams first), the
server's reset and stop-sending and the page's, a refused session (404 and
403), the protocol the server picks, the page's own headers (Chrome 157;
none before it), a server that does not read, a
certificate the WebPKI takes (through the proxy, the root the test
transport gives epoxy), a hash that is not the certificate's, a session in
a worker, and one the content blocker's list refuses, which the server
never hears of through the proxy. Natively Chrome takes the server's
certificate with a pinned hash, or with `--ignore-certificate-errors-spki-list`
and `--origin-to-force-quic-on`.

## Wisp over WebTransport

Everything above is about the page's own sessions. The transport can also
use a WebTransport session itself, as the carrier of its wisp connection
in place of the WebSocket (`TransportDescriptor.webTransport`, off unless
set in the library, on in the demo, `src/transport/wispWebTransport.ts`),
the way holyWisp's WebTransport listener serves it (holyWisp's
docs/webtransport.md, "Wisp on the session" and "Certificates"):

- **Where the session is.** `url` names it, its certificate checked as any
  site's (a relay with a public name and a Web PKI certificate). With
  neither option, a `wss:` wisp URL is dialed as `https:`, its host and
  path kept: the relay's session on its own name, everything on one
  domain, as holyWisp serves it on the WebSocket's host and path. Only
  when that session cannot be had is `GET /webtransport.json` on the wisp
  URL's origin asked (`ws:` read as `http:`, `wss:` as `https:`; a `ws:`
  wisp URL has no name to check a certificate by and asks it first), and
  `discovery` names a document to ask instead of dialing. A document
  answers `{ url, hashes: [{ algorithm: 'sha-256', value }] }`, the value
  in base64: the current certificate and the previous one, for a relay
  with no public name that makes its own. The session is the document's
  `url`, or the document's own origin over `https:` when it lists none,
  never the page's or the wisp URL's: a relay behind Cloudflare (whose UDP
  443 never reaches the edge) names a host of its own there, as the edges'
  `https://holywisp.fracit.al/webtransport.json` names
  `https://holywisp.fracit.al/`. On an app's host that path is the app's:
  a 404, an error or a page that is not JSON is no document. A document,
  or its absence, is kept for an hour per URL in this realm and in
  IndexedDB (`stomp-wisp-carrier`), so an origin asks it at most once an
  hour, and a session that worked by a derived URL is had again without
  it.
- **Certificates.** Every `sha-256` hash listed goes in one handshake's
  `serverCertificateHashes`: Chrome takes a certificate whose hash is any
  of them, so the current one and the previous one are both tried at once,
  and a failed handshake costs a round trip and stays in Chrome's throttle
  for five minutes (that page's or worker's, not the next one's). When the handshake fails, the document is fetched
  again (it may have rotated between the two), and a document that changed
  gets one more handshake. A document with no hashes leaves the
  certificate to the Web PKI.
- **The Wisp stream.** One bidirectional stream carries the Wisp packets,
  each after its length as a u32 LE (epoxy-server's LengthDelimitedLe),
  read as they arrive whatever QUIC cut them into. epoxy takes the session
  as its function transport (`EpoxyClient`'s `wisp` may be a function
  returning `{ read, write }`, one packet per chunk), so the Wisp in it is
  epoxy's own, v1 and v2.
- **Datagrams.** The transport watches the CONNECTs and CLOSEs it sends and
  hears: a DATA packet of a UDP stream that fits `maxDatagramSize` goes as
  one datagram, whole, with no prefix, and one that does not on the
  stream; a datagram that arrives is one packet. Nothing else ever goes as
  a datagram. Chrome reads about 1215 for a session on loopback, five of
  which the Wisp header takes: stomp-h3's QUIC packets after the handshake
  (1200 bytes, no path MTU probes) and most WebRTC packets fit, and
  stomp-h3's Initials (padded to 1250, as Chrome's) go on the stream.
- **HTTP/3 inside.** stomp-h3's QUIC rides a UDP stream like any other, so a
  connection's packets take both ways: its 1250-byte ones (Initials, full
  packets of a request body) on the stream, the rest (requests,
  acknowledgements) as datagrams, and the server's the same by holyWisp's
  datagram size. QUIC takes the two as one path that reorders and loses
  some, as it takes UDP. Over `wss://holywisp.fracit.al/` on 2026-11-19
  (headless Chrome 157, this machine behind a WireGuard tunnel of MTU 1360)
  the server's packets came as datagrams of up to 1285 bytes and ones of
  1477 on the stream (quic.nginx.org's), and the inner connection lost none
  of its packets. After holyWisp's BBR and backpressure fixes that day, a 20
  MB range of dl.google.com read from the transport itself, twice per
  carrier and version (Mbit/s, cold then warm): HTTP/2 over the session (the
  stream alone) 43 and 49, HTTP/3 (mostly datagrams) 51 and 86; over the
  WebSocket HTTP/2 51 and 101, HTTP/3 15 and 33. HTTP/3 is fastest through
  the session (where over the WebSocket each inner packet waits behind
  TCP's), and HTTP/2 through it matches the WebSocket cold and runs about
  half of it warm. Before those fixes the session ran either at 15 to 32:
  the slow part was the relay's QUIC sending, not the datagrams.
  speed.cloudflare.com offers no h3 (no Alt-Svc, no HTTPS record asked), so
  a download from it is HTTP/2 on the stream whatever the carrier. A path
  that took the handshake and then carried no datagrams held an h3 request
  for quinn's 30 s idle timeout, and the next one again; Chrome's blackhole
  delay and its broken mark now end that (docs/http3.md, rules 3 and 6;
  `webtransport-wisp`).
- **Wisp v2** (`wisp_v2` in epoxy's options) is offered as the protocol
  `wisp-v2`; holyWisp answers it with `wt-protocol` and opens v2 with INFO,
  as it does for a WebSocket with a subprotocol.
- **Choosing: UDP first, never waiting on it long.** UDP is often
  blocked, and a network that drops it looks like a handshake that never
  ends (Chrome gives up after 4 s). What each relay did is remembered by
  its plan (`url`, the document's URL, or the wisp URL) in this realm and
  in IndexedDB for the origin's next page and worker:
  - nothing known: the session and the WebSocket are opened together. The
    session is taken when its Wisp stream's first packet comes within half
    the WebSocket's own time after the WebSocket's (150 to 400 ms) and its
    handshake was done within a tenth of it (50 to 100 ms); else the
    WebSocket. The one not taken is closed as soon as it is open (the
    WebSocket with 1000, the session with a close), so the relay holds
    nothing for it, and the outcome is remembered: a session that came up
    too late for this start is had by the next.
  - it worked (for 7 days): the session, within `timeoutMs` (2 s by
    default), else the WebSocket;
  - it failed (no session at the derived URL nor a document, a document
    that names no https URL, a handshake that fails or times out, a stream
    that cannot be opened): the WebSocket alone for 30 s, then the
    WebSocket at once with a session tried beside it on each start, so a
    network whose UDP came back is on the session from the next page. A
    network change (`online`, a `navigator.connection` change) and a
    session that ended under its requests without a close end the 30 s at
    once.

  Epoxy is handed the chosen carrier as its function transport, the
  WebSocket as well (opened as epoxy's own: its protocols, one more to ask
  for v2), so the one not taken can be closed and each choice timed; the
  transport as given (epoxy's own WebSocket by URL) is what is left when
  neither could be opened, and a relay that is down fails each request as
  it did.

  Measured from headless Chrome 157 to `wss://holywisp.fracit.al/` and
  `https://holywisp.fracit.al/` (about 130 ms away; 45 starts, each in a
  fresh context, both opened together; probes in
  `~/.claude/stomp-work/wt-first/probe`): the WebSocket's first Wisp
  packet came at 435 ms (p50; 178 to 964), the session's handshake was
  done with it (-1 ms p50, within 10 ms in 44 of 45), and its Wisp
  stream's first packet came a round trip later, 128 ms (p50), 172 ms
  (p90), 182 ms (max) after the WebSocket's, 29 %, 42 % and 45 % of the
  WebSocket's time. Chrome sends a stream only once the session is up, so
  creating it before `ready` saves nothing (139 against 145 ms). The
  handshake alone took 477 ms (p50) and 1587 ms at most, under the 2 s of
  `timeoutMs`. Through the built transport (10 starts each in the worker
  and in the page, a fresh context each, from the controller's start):
  the derived session was chosen in all 20 starts. With the session at a
  port that refuses UDP (it fails in about 170 ms, before the WebSocket is
  up) the choice was the WebSocket at 507 and 504 ms (p50, worker and
  page), and at an address that drops it (no answer: Chrome's 4 s) at 576
  and 577 ms: the tenth of the WebSocket's time given to the handshake, 50
  ms here, is what a network that drops UDP pays, once per origin. The
  first answer through the relay varied more between runs than between
  settings (with the carrier off 747 to 6172 ms in the worker; p50 1223
  off, 973 refused, 1051 dropped; in the page 960, 1006, 1107). On loopback
  (`webtransport-wisp`) the first start rides the session, and with UDP
  blocked the first request answers within the suite's 400 ms of the
  carrier off.

  Each choice is one line on the console, `STomp transport` then `Wisp
over WebTransport (UDP/QUIC) to <url>, <ms> ms` or `Wisp over WebSocket
(TCP) to <url>, <ms> ms; WebTransport: <why>`, and another when a
  revived transport rides the other carrier (`switched from WebTransport
to WebSocket`). The transport's `carrier` and `info` say it, and the
  controller's `carrier` (a `carrier` event each time, from the transport
  worker or the page, through the controller frame to a
  `StompRemoteController`) gives the host what the demo shows: a UDP or
  TCP tag on its menu button, the carrier, time, relay and why not UDP
  atop the menu and in About's Transport row. No proxied page is told.

- **Revival.** A transport keeps its carrier: when the session ends, the
  packets' readable ends as a closed WebSocket's does, the next wisp
  connection epoxy asks for fails with `WebTransportCarrierLost`
  (RevivingTransport's DEAD), and RevivingTransport makes a new transport,
  which chooses again: the requests it sends again are those it sends
  again after a lost WebSocket. A session the relay closed (a restart that
  closes its sessions first) keeps the relay remembered as working; one
  that ended without a close (UDP lost under it, a relay that went away)
  is remembered as lost, so the new transport rides the WebSocket at once
  and the session tried beside it tells the two apart.

It rests on epoxy-tls's `deploy/epoxy` patch 0075 (in the pinned build),
which makes a function transport's writes never wait, as the WebSocket's
`send` does not. Every
stream of a wisp connection writes through one sink behind wisp-mux's
lock, and epoxy's function-transport sink (wasm-streams' IntoSink) is
Pending until the WritableStream's `ready` and `write` promises settle, a
microtask later at the soonest. A writer that met Pending kept the lock.
rustls polls `poll_flush` once in a handshake, and on Pending goes on to
read without flushing again; the multiplexor's actor then waited for the
lock to send the next stream's CONNECT and read nothing meanwhile, so the
server's answer never arrived. Measured in Chrome 157 with a WebSocket
behind a function transport: one https request with two plain http ones
beside it hung all three (only its CONNECT and ClientHello went out), and
in sequence they loaded (`epoxy-function-transport`). Without the patch
every page load over the session that opened more than one origin at once
hung. No STomp path handed epoxy a function transport before the carrier.

### What a browser client cannot do of holyWisp's design

- `serverCertificateHashes` takes only a certificate of at most 14 days of
  validity that holds now, an X.509 v3 one with an ECDSA key in Chrome's
  WebTransport (holyWisp makes P-256, valid from an hour ago for 13 days,
  which fits; a `webtransport-cert` chain goes through the Web PKI with no
  hashes). A clock more than an hour behind the server's refuses a fresh
  certificate.
- The hashes apply to that one session to that URL only: no pooling, no
  other origin, and the page cannot reuse them for a `fetch` of the same
  host. The document itself has to come over HTTPS from a certificate the
  browser trusts (or plain HTTP on loopback), on TCP.
- The WebTransport URL has to reach the UDP listener directly. A wisp
  host behind a proxy that carries only TCP (Cloudflare's, or OpenResty in
  front of terp) needs `webtransport-url` naming an address that is not
  proxied, and the client has nothing to derive it from otherwise: the
  descriptor's `discovery` or `url` has to name that host. A relay that is
  keyed by its path (the edges' keyed relay) loses the key when the
  document lists no `url`: the document's `url` has to carry it.
- A failed or timed-out handshake stays in Chrome's throttle for five
  minutes, and every one pending doubles the next one's wait (the page's
  or worker's own throttle), so a client cannot probe a relay over and
  over: one try per transport start, none for 30 s after a failure.
- A page that has never met a relay cannot know whether UDP reaches it
  without waiting for a handshake, and a session's Wisp stream answers a
  round trip after the WebSocket's (Chrome opens a stream only on a
  session that is up, and the relay speaks first on it): the first start
  waits that long for it after the WebSocket, and for a network that
  drops UDP a tenth of the WebSocket's time, once per origin.
- `WebTransport` exists only in secure contexts: a host page on plain
  `http:` (not localhost) has none, and gets the WebSocket.
- Chrome drops a datagram larger than the connection takes without a word,
  and a datagram arriving faster than it is read past
  `incomingHighWaterMark`; the client reads them at once, and keeps a UDP
  packet larger than `maxDatagramSize` to the stream.
- After the server closes a session Chrome answers with a FIN on the
  CONNECT stream and never with CONNECTION_CLOSE (the measurements above):
  the server reaps the connection.

`webtransport-wisp` covers it, with the transport in its worker and in the
page: test/wisp-wt.mjs is a relay of holyWisp's design in front of the
demo's holyWisp (the document on its TCP port; on its UDP one
test/wtserver.mjs's `/bridge` route, whose streams and datagrams the relay
serves), and when holyWisp's own build with the listener is on the machine
(`HOLYWISP_WT`, or `~/src/holyWisp/build/release/holywisp`) the suite runs a
page, a socket and UDP through it too, skipped otherwise. The demo turns
the carrier on (`STOMP_WISP_WEBTRANSPORT`, demo/README.md): through
`wss://holywisp.fracit.al/` on 2026-11-18 its second start rode the edge's
session, pages loaded and a page's WebSocket echoed.
