# WebRTC over wisp

The plan for giving a proxied page real WebRTC (data channels, audio, video,
with real peers on the internet) while every packet travels through the wisp
tunnel and nothing leaves from the user's machine. Written 2026-11-10 against
master a8a457b, after the leak fix in docs/webrtc.md (which keeps the
browser's own `RTCPeerConnection` and sends it nowhere). This document
replaces that design's "no peer outside the browser" limit with a WebRTC
stack of STomp's own, in wasm, in a worker next to the page, fed by wisp UDP
and TCP streams.

Nothing here lands at once: the phases in section 11 each pass the full
suite set and the `webrtc` suite's leak checks, which stay strict
throughout.

Phase 1 (data channels with real peers) is built. Sections 1 to 14 are the
plan as it was written; section 15 says what Phase 1 is, what was measured,
and where it differs from the plan.

## 1. Why not the browser's stack, and why not an operator TURN server

The browser's ICE agent sends from the network service, from the user's
address, to whatever the page names; a service worker or a page can neither
carry those packets nor see them. docs/webrtc.md measured it: a STUN server
hears the user's address, a TURN server gets allocations, a remote candidate
gets connectivity checks, and with media access the page reads the LAN
addresses. The fix there makes the browser behave as on a network that
drops UDP, so today a proxied page connects to nothing outside this browser.

The operator TURN server (option 1 in docs/webrtc.md) keeps the browser's
stack and points it, relay-only, at a TURN server the host runs. It cannot be
shown leak-free from inside the page:

- the browser still resolves the TURN host through the user's resolver and
  connects to it from the user's address, so the TURN operator sees the user,
  as the wisp operator does today, but a second party does;
- `iceTransportPolicy: 'relay'` is applied by a hook; every path that reaches
  the native constructor or `setConfiguration` (another realm's member, a
  realm the inject does not cover) is a path around it, and the suite can
  only enumerate the ones it knows;
- the relay candidate's `raddr` is the user's public address and has to be
  hidden by hand everywhere it can be read, which is the whole redaction
  surface of docs/webrtc.md again, forever;
- the host has to run TURN servers with short-lived credentials and pay for
  their bandwidth, outside this repository.

So the stack moves into STomp. The page's own STUN and TURN servers are
reached through wisp (they hear from the edge), peers are reached through
wisp (they see the edge), and the browser's `RTCPeerConnection` is never
constructed by a page: the threat model becomes "no packet outside wisp"
by construction, the same as HTTP and WebSockets, instead of "no packet the
hooks failed to redirect".

## 2. What the wire allows

A wisp UDP stream (protocol v1 and v2, wisp-js 0.5, holyWisp with
`allow-udp = on`) is a socket the server opens to one `host:port` and
connects: wisp-js calls `dgram.Socket.connect(port, ip)` on it
(`node_modules/@mercuryworkshop/wisp-js/src/server/net.mjs`), so datagrams
from any other peer are dropped by the kernel, and the client learns neither
the socket's own address nor the sender of what it reads. A wisp TCP stream
is one connection to one `host:port`. That shapes the whole ICE design:

| ICE needs                                                       | What wisp gives                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one socket per host candidate, talking to every remote          | one stream per remote: a `(local candidate, remote address)` pair is a stream, opened when the agent first sends to that remote                                                                                                       |
| a srflx candidate the peer can send to                          | the STUN Binding goes out on a stream connected to the STUN server, so the address it reports (the edge's socket) only accepts packets from the STUN server; a peer sending there reaches nothing                                     |
| host candidates                                                 | none exist: the "host" is the edge, whose socket is not known before it sends                                                                                                                                                         |
| a relay candidate                                               | works as designed: one stream to the TURN server carries every peer's traffic in TURN indications and channels, with the peer's address inside the message                                                                            |
| the peer learning our address                                   | peer-reflexive discovery: the first connectivity check we send to a remote candidate reaches it from the edge socket of that stream; the peer adds a prflx candidate for it and its checks come back to the same connected socket     |
| an ICE-lite peer (SFUs: mediasoup, Janus, LiveKit, Pion-based)  | sends no checks of its own, answers ours, uses the prflx pair: works on the stream path with no STUN or TURN at all                                                                                                                   |
| a full-ICE peer (another browser) behind a cone NAT             | its checks to our srflx reach nothing; its triggered checks to the prflx pair reach the stream: works                                                                                                                                 |
| a full-ICE peer behind a port-restricted or symmetric NAT       | its NAT opened for the address it sent to (our srflx), not for the stream's socket; the direct path fails; the pair through the page's TURN server works                                                                              |
| TCP candidates (`tcptype passive` peers, TURN over TCP and TLS) | a wisp TCP stream per remote, RFC 4571 framing for ICE-TCP, epoxy's `connect_tls` for `turns:` (Chrome's ClientHello, the same TLS stack HTTPS uses)                                                                                  |
| mDNS host candidates                                            | nothing on the LAN ever: each document shows a random `<uuid>.local` host candidate (what Chrome shows without media access) that resolves only through STomp's own bridge between two proxied documents of one browser (section 5.4) |

Every real WebRTC service that matters routes through servers with public
addresses (SFUs) or offers TURN; a browser-to-browser call without TURN
across two restrictive NATs is the one shape that stays out of reach, and
it is the one the page's own `iceServers` exist for. Where the wisp server
refuses UDP (`allow-udp = off`), connections fall back to TURN over TCP or
TLS, as Chrome does on a UDP-blocked network, with the same 701 errors.

The holyWisp edges relay UDP since abulxt 853761c7 (`holywisp_allow_udp`,
`proxy_udp_direct`), the demo's wisp-js relays it by default, and both
refuse private, loopback and link-local destinations (so a peer's private
host candidates fail at once, as they would from another network). A
proxied page's packets leave from the edge; browserleaks.com/webrtc shows
the edge's address under "Public IP", which is what every other row of that
page already shows for a proxied user.

## 3. Pieces

| Piece                       | Where                                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the stack                   | `rust/rtc/` (Rust, wasm32), built by `deploy/rust/build.sh` to `assets/rtc.wasm` | str0m 0.25 (sans-IO: ICE, DTLS 1.2 and 1.3 through dimpl with the pure Rust crypto backend, SRTP, SCTP, RTP packetizing and depacketizing for Opus, VP8, VP9, H.264, AV1, RTCP feedback, bandwidth estimation, stats), plus STomp's own STUN Binding client, TURN client and ICE-TCP framing. One wasm instance per rtc worker holds every connection of that document.                                              |
| the rtc worker              | `src/rtc/worker.ts`, built to `dist/rtcWorker.js`, an `Assets` key               | A dedicated Worker the inject starts for a document the first time it constructs an `RTCPeerConnection`. Instantiates the module from bytes the host supplies through the shared loader, drives the stack (input, output, timers), owns the wisp streams through the document's transport port, runs the WebCodecs encoders and decoders, and speaks to the page over MessagePorts.                                  |
| the stand-in                | `src/inject/dom/modules/WebRTC.ts` (rewritten) and `src/rtc/api/`                | `RTCPeerConnection` and the objects around it as classes of STomp's own that read as native (section 7). Thin: every method is a message to the worker and a promise of the page's realm; every event is a message back.                                                                                                                                                                                             |
| the datagram and stream RPC | `src/transport/messages.ts`, `serveTransport.ts`, `StreamTransport.ts`           | Two calls on the transport port a page already has (`TRANSPORT_RPC`): `udp(host, port)` and `tcp(host, port, tls)`, each answered with a MessagePort that carries one datagram (or one chunk) per message. The transport worker opens them on epoxy's `connect_udp`, `connect_tcp` and `connect_tls`; libcurl has none, so with libcurl `RTCPeerConnection` behaves as on a network without UDP or TCP (section 10). |
| the media bridge            | `src/rtc/media/` (page side and worker side)                                     | `MediaStreamTrackProcessor` on the page's thread hands its `readable` of `VideoFrame`s or `AudioData` to the worker by transfer; `MediaStreamTrackGenerator` hands its `writable` the same way, so the page gets a real `MediaStreamTrack` for `<video>` and `<audio>`. Encoding and decoding run in the worker with WebCodecs.                                                                                      |
| the loader                  | `src/wasm/` (the Rust rewriter agent's, docs/rust-plan.md section 6)             | Compiles `assets/rtc.wasm` once per controller from bytes, a URL or a `WebAssembly.Module` the host hands over, and posts the compiled module to the rtc worker. Nothing is fetched until a page makes a connection.                                                                                                                                                                                                 |
| the same-browser bridge     | `src/rtc/local.ts`                                                               | Two proxied documents of one browser (frames, tabs) connect without the network: their rtc workers exchange datagrams over a MessagePort brokered on the `$stomp$webrtc` BroadcastChannel, keyed by the `.local` names they showed (section 5.4).                                                                                                                                                                    |

Measured on Chrome 152 (headless, `/home/user/.claude/jobs/482f9578/tmp/webrtc-fable/caps1.mjs`, `caps2.mjs`): `VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder`
exist in dedicated workers on a secure context (not on `about:blank`) and
report VP8, VP9, H.264 (`avc1.42001f`), AV1 and Opus supported;
`MediaStreamTrackProcessor` and `MediaStreamTrackGenerator` exist on the
window only, `VideoTrackGenerator` does not exist, and a `MediaStreamTrack`
is not transferable to a worker (`DataCloneError`). The processor's
`readable` and the generator's `writable` are transferable, which is the
bridge above.

## 4. The stack's boundary

The crate follows the conventions of `rust/` (docs/rust-plan.md sections 3,
6 and 7): a `cdylib`, single-letter exports listed in `rust/rtc/abi.json`,
no wasm-bindgen, no `import.meta.url`, the artifact checked by
`deploy/rust/check.mjs` (no custom sections, no token of the list in the
bytes), built by `deploy/rust/build.sh rtc rtc` in the pinned toolchain
container, committed as `assets/rtc.wasm` with its `.sha256` and
`UPSTREAM`, and copied into `dist/` by `build.js`.

Sans-IO fits a hand-written boundary exactly: the host feeds records in,
asks for records out, and tells the stack when its next timer is due.

| Export | Meaning                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `m`    | the memory                                                                                                                |
| `a`    | `alloc(len) -> ptr`, `f(ptr, len)` frees                                                                                  |
| `c`    | `create(ptr, len) -> id`: a connection from a configuration record (ICE servers, policy, certificates, codec choices)     |
| `i`    | `input(id, kind, ptr, len) -> status`: a datagram received on a stream, a stream's open or close, a page call (section 6) |
| `t`    | `tick(id, now_ms) -> status`: the clock advanced; timers run                                                              |
| `o`    | `output(id) -> len`: the next output record into the scratch (`p()` its pointer), 0 when there is none                    |
| `d`    | `destroy(id)`                                                                                                             |
| `p`    | the scratch pointer the output records are written at                                                                     |

Input records (`kind`): `datagram` (stream handle, bytes), `stream-open`
(handle, the address it was opened to), `stream-closed` (handle, why), and
the page's calls as tagged records: `offer`, `answer`, `set-local`,
`set-remote`, `candidate`, `channel-open`, `channel-send`,
`channel-close`, `media-add`, `media-direction`, `media-frame` (an encoded
frame to packetize: mid, rid, pt, timestamp, keyframe, bytes),
`media-stop`, `bitrate`, `stats`, `close`.

Output records: `send` (open a stream to this address, or send on this
handle, bytes), `event` (the page-visible events: candidate, gathering and
connection states, channel open and message and close, track added, stats
reports), `frame` (a depacketized encoded frame to decode: mid, rid, codec,
timestamp, keyframe, bytes, which the worker feeds its decoder), `keyframe`
(the peer asked for one, PLI or FIR), `bitrate` (the estimate the encoder
should follow), `timer` (the next tick wanted, in ms).

Records are a flat binary layout (a u8 tag, u32 lengths, UTF-8 for text),
written and read by the worker with a `DataView`: no JSON on the media
path, where a frame of VP8 is a copy into the stack's memory and a copy out
again and nothing else.

### Clock and randomness

str0m, sctp-proto and the ICE agent take `Instant` from the caller for every
decision (the rest of the `Instant::now()` calls in their sources are in
tests), but sctp-proto's `connect` path still calls it, and an `Instant`
cannot be made any other way; `rand::rng()` seeds from `getrandom`, and DTLS
keys, ICE credentials and SCTP cookies need real randomness. On
`wasm32-unknown-unknown` the standard library has no clock (`Instant::now`
aborts) and `getrandom` has no source without wasm-bindgen glue. The crate
is therefore built for `wasm32-wasip1`: the standard library's clock,
randomness and stdout become a handful of imports in the
`wasi_snapshot_preview1` module (`clock_time_get`, `random_get`,
`fd_write`, `environ_get`, `environ_sizes_get`, `proc_exit`,
`sched_yield`), which the worker answers in about forty lines
(`performance.now()` and `Date.now()`, `crypto.getRandomValues`, a write
that discards, an exit that throws). They are listed in `abi.json` like
any import, their names are the WASI standard's (every Emscripten module
carries the same, so they are no signature of this project), and the
toolchain needs the `wasm32-wasip1` target added next to
`wasm32-unknown-unknown` plus a per-crate target marker read by
`compile.sh` (a `target` file in the crate directory, the way `bindgen` is
read today). The `-Z build-std` flags apply unchanged; the wasi libc
objects come with the rustup target. If that target is unwelcome in the
shared image, the fallback is `wasm32-unknown-unknown` with `getrandom`'s
`custom` backend answered by a one-function import and a patched
`std::time::Instant` source in the few crates that call `now()`; the
WASI route is smaller and touches no dependency.

### What is in the bytes

str0m writes `o=str0m-<version>` into every SDP it generates; STomp never
hands that text to a page (section 6), and the token scan does not look
for the library's name, but the string is in the artifact and says what
the stack is. If that matters to a host, the SDP renderer below can be the
only SDP writer (str0m's `DirectApi` path) and the string goes away; that is
noted as a later option, not a phase.

Estimated size: str0m with the pure Rust crypto backend, SCTP, the ICE
agent and the codec packetizers is in the order of 1 to 1.5 MB of wasm
before `-Oz` and `optimize_for_size`, about 350 to 450 KB over the wire with
brotli. The exact figure is reported with phase 1 and becomes the budget.

## 5. ICE as the page sees it

### 5.1 Local candidates

For each connection, in the order Chrome emits them:

1. **One host candidate per component** with a random `<uuid>.local`
   address, UDP, the priority Chrome gives a host candidate. This is what
   Chrome shows without media access. It resolves nowhere on the network;
   it is the key of the same-browser bridge (5.4). With a candidate pool or
   `iceCandidatePoolSize`, gathered at construction as Chrome does.
2. **One srflx candidate per STUN server the page named** (and per TURN
   server, which Chrome also asks as STUN), from a Binding request sent on
   a stream to that server through wisp: `address` is the edge's, `raddr`
   `0.0.0.0` (what Chrome shows for the related host address without media
   access). The peer cannot reach it (section 2); it exists because pages
   and leak tests read it, and because a full-ICE peer uses it as the
   address its NAT opens for.
3. **One relay candidate per TURN server** the page named, from an
   Allocate on a stream to that server (UDP, TCP, or TLS through
   `connect_tls`), with the long-term credential flow (401, realm, nonce,
   MESSAGE-INTEGRITY, the credentials from the page's `iceServers`), a
   refresh timer, permissions for each remote candidate the agent pairs it
   with, and channel bindings once a pair is nominated (ChannelData, not
   Send indications, on the selected pair).
4. **`icecandidateerror`** for a server that does not answer: 701, the
   texts and the timing of Chrome's (docs/webrtc.md measured them: about
   39.9 s for STUN, 60 ms later for TURN over UDP, at once for TCP that
   fails), `address` `0.0.0.x`, `hostCandidate` as Chrome redacts it. A
   server name that does not resolve fails as Chrome's does; the resolution
   happens on the wisp server.
5. **Gathering states** `new`, `gathering`, `complete` as Chrome sequences
   them, the end-of-candidates event (`candidate: null`, then the
   `candidate: ''` Chrome fires), and `iceTransportPolicy: 'relay'` keeping
   only (3).

Every address the page can read is the edge's or `0.0.0.0` or a `.local`
name. The user's addresses never exist in the worker.

### 5.2 Remote candidates

A remote candidate (from `addIceCandidate` or the `a=candidate` lines of a
remote description) is handed to the agent as it is. When the agent first
transmits to it, the worker opens a wisp stream to its address, on the
transport kind the candidate names:

- UDP host, srflx and relay candidates: a UDP stream each;
- TCP candidates with `tcptype passive` or `so`: a TCP stream each, with
  RFC 4571 length framing; `active` candidates cannot be reached (Chrome
  does not connect to them either);
- a candidate whose address the wisp server refuses (private, loopback,
  link-local) gets its stream closed at once, which fails the pair as
  "unreachable" without a timeout.

Each stream is the `(local candidate, remote address)` pair for the agent:
received datagrams enter the stack with `source` = the remote address the
stream was opened to and `destination` = the local candidate's address, so
pair matching, prflx discovery on our side and the selected pair are the
agent's own logic. The relay candidate's streams are different: one stream
to the TURN server carries every remote, as TURN messages, and the TURN
client in the crate unwraps Data indications and ChannelData into
`(source: the peer, destination: the relayed address)` inputs.

A connection never has more than about a dozen streams (remote candidates
of a typical offer), and streams of failed pairs are closed when the agent
drops the pair; a nominated pair keeps one stream open, and ICE restarts
start over.

### 5.3 Connectivity

str0m's agent runs the checks, retransmissions, nominations (the
controlling role per the offer), keepalives, consent freshness, and
restarts; `iceconnectionstatechange` and `connectionstatechange` follow
the agent's and DTLS's states with Chrome's state machine (`checking` on
the first pair, `connected` on the first nomination, `completed` when every
pair is settled, `failed` after the agent gives up, `disconnected` on
consent timeouts). The timing differs from Chrome's where the tunnel adds
its round trip; the suites assert order and the page-visible values, not
milliseconds.

### 5.4 Two proxied pages in one browser

Today two proxied documents open a data channel through the browser's own
stack (mDNS names shared on `$stomp$webrtc`). That stays, without the
network: an rtc worker that is asked to transmit to a `.local` name
announced by another document of this browser (the BroadcastChannel carries
the announcements, as today) brokers a MessagePort to that document's
worker over the same channel and exchanges datagrams on it, with the two
names as the pair's addresses. It is the path the existing suite's local
checks exercise, it costs nothing on the wire, and it is the only place a
`.local` name ever means anything. A name no document announced waits the
200 ms the current module waits, then fails the pair.

## 6. SDP

Negotiation is str0m's (`SdpApi`: `add_media`, `add_channel`,
`set_direction`, `apply` for an offer, `accept_offer` for an answer,
`accept_answer` to complete, `ice_restart`), so payload type negotiation,
extension maps, SSRC allocation, simulcast rids, BUNDLE and rtcp-mux are one
implementation with the packets. What the page reads is not str0m's text.
A renderer in the worker turns the negotiated state into SDP in Chrome's
shape, from the `o=- <id> <version> IN IP4 127.0.0.1` line and
`a=msid-semantic: WMS` through each `m=` section's line order (`c=`,
`a=rtcp:9 IN IP4 0.0.0.0`, `a=ice-ufrag`, `a=ice-pwd`, `a=ice-options:trickle`,
`a=fingerprint:sha-256`, `a=setup`, `a=mid`, extmaps, direction, `a=msid`,
`a=rtcp-mux`, `a=rtcp-rsize`, `rtpmap`, `rtcp-fb`, `fmtp` per payload type in
Chrome's default codec order and payload numbers, `a=ssrc-group:FID` and the
`a=ssrc` lines with cname and msid, `a=sctp-port:5000` and
`a=max-message-size:262144` for the application section), with the
candidates rendered per 5.1. The renderer is measured against Chrome 152
and 156 offers and answers recorded by the suite (data channel only, audio,
video, both, simulcast, after `addTransceiver` of each direction) and
compared line by line with the identifiers normalised. The IDs the page can
match across calls (ufrag, fingerprint, mids, SSRCs, payload types,
extension ids) are the stack's real ones, so what the page signals is what
the wire uses.

Remote descriptions go to str0m's parser as the page gave them: Chrome's,
Firefox's, Safari's and the Node and native stacks' SDP parse. Errors
become `RTCError`s and `DOMException`s with Chrome's names and texts for the
cases the suite records (a missing `type`, an answer without an offer, a
`rollback` in the wrong state, a bad `sdpMid`, a candidate for an unknown
section).

What a page changes in a local description before `setLocalDescription`
(munging) is kept as the presented description; the stack applies what it
can (removed codecs, `b=AS` and `x-google-*` bitrate hints, reordered
codecs) and ignores the rest, which is Chrome's current policy (it rejects
munged ufrag and pwd and most other edits). `setLocalDescription()` with no
argument and `createOffer({ iceRestart })` behave as Chrome's.

## 7. The API surface and how it reads as native

Everything on this list is a class of STomp's own in the page's realm,
installed by the WebRTC module in every document the inject covers, in
place of the browser's (`RTCPeerConnection` and `webkitRTCPeerConnection`
are the same function, as natively). It follows the patterns of
docs/scramjet-parity.md and the memory notes on inject hooks: realm
constructors from `client.global`, natives captured at load, promises of the
page's realm (`realmThen`), `ProxyModule.wrapFunction` for every function so
`toString`, `name` and `length` are the native's, prototype chains and own
property descriptors copied from the native prototypes (the `native-shapes`
suite already compares every constructor's shape natively and proxied, so
these join its list), events dispatched as trusted events on the objects
(`isTrusted` true: the objects are real `EventTarget`s, the events are
constructed by the inject and dispatched natively), and `instanceof` against
the native classes holding (the stand-ins' prototypes inherit from the
native prototypes, as the Location stand-in's does).

| Object                                                       | Surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RTCPeerConnection`                                          | constructor with configuration validation (Chrome's errors for a bad URL, a TURN URL without credentials, a bad policy), `createOffer` and `createAnswer` (promise and legacy callback forms, `offerToReceiveAudio/Video`, `iceRestart`), `setLocalDescription` and `setRemoteDescription` (implicit and `rollback`), `addIceCandidate` (both forms, end-of-candidates), the six description getters, `signalingState`, `iceGatheringState`, `iceConnectionState`, `connectionState`, `canTrickleIceCandidates`, `sctp`, `addTrack`, `removeTrack`, `addTransceiver`, `getTransceivers/Senders/Receivers`, `createDataChannel`, `getStats`, `getConfiguration`, `setConfiguration`, `restartIce`, `close`, `generateCertificate` (static), every `on*` handler, the operations chain (calls queue behind one another as the browser's do) |
| `RTCDataChannel`                                             | `label`, `ordered`, `maxPacketLifeTime`, `maxRetransmits`, `protocol`, `negotiated`, `id`, `readyState`, `bufferedAmount`, `bufferedAmountLowThreshold`, `binaryType` (`arraybuffer` default, `blob`), `send` (string, ArrayBuffer, view, Blob), `close`, `open/message/closing/close/error/bufferedamountlow` events, in-order and partial reliability through SCTP, the 256 KiB message limit with Chrome's error                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RTCRtpTransceiver`, `RTCRtpSender`, `RTCRtpReceiver`        | `mid`, `direction`, `currentDirection`, `stop`, `stopped`, `setCodecPreferences`; sender `track`, `replaceTrack`, `getParameters` and `setParameters` (encodings with `maxBitrate`, `scaleResolutionDownBy`, `active`, `rid`, `priority`), `getStats`, `setStreams`, `transport`, `dtmf`; receiver `track`, `getParameters`, `getStats`, `getContributingSources`, `getSynchronizationSources`, `jitterBufferTarget`; static `getCapabilities` answering Chrome's codec and header extension lists                                                                                                                                                                                                                                                                                                                                        |
| `RTCIceTransport`, `RTCDtlsTransport`, `RTCSctpTransport`    | `role`, `state`, `gatheringState`, `getLocalCandidates`, `getRemoteCandidates`, `getSelectedCandidatePair`, `getLocalParameters`, `getRemoteParameters`; DTLS `state`, `getRemoteCertificates`; SCTP `maxMessageSize`, `maxChannels`, `transport`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RTCIceCandidate`, `RTCSessionDescription`, `RTCCertificate` | the parsed fields (`foundation`, `component`, `priority`, `address`, `protocol`, `port`, `type`, `tcpType`, `relatedAddress`, `relatedPort`, `usernameFragment`, `url`), `toJSON`; `RTCCertificate.expires`, `getFingerprints`, a certificate handed in `certificates` is the DTLS certificate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RTCDTMFSender`                                              | `insertDTMF`, `toneBuffer`, `canInsertDTMF`, `tonechange`: RFC 4733 telephone-event packets as Chrome's sender writes them (section 16)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| events                                                       | `RTCPeerConnectionIceEvent`, `RTCPeerConnectionIceErrorEvent`, `RTCTrackEvent`, `RTCDataChannelEvent`, `RTCDTMFToneChangeEvent`, `RTCErrorEvent` with `RTCError` (`errorDetail`, `sdpLineNumber`, `sctpCauseCode`, `receivedAlert`, `sentAlert`, `httpRequestStatusCode`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `getStats`                                                   | an `RTCStatsReport` (a real `Map` subclass with the native prototype shape) of Chrome's report types with Chrome's fields and ids: `peer-connection`, `transport`, `candidate-pair`, `local-candidate`, `remote-candidate`, `certificate`, `codec`, `inbound-rtp`, `outbound-rtp`, `remote-inbound-rtp`, `remote-outbound-rtp`, `media-source`, `media-playout`, `data-channel`; the numbers from str0m's `PeerStats`, `MediaIngressStats` and `MediaEgressStats` and the worker's encoder and decoder counters. Candidate addresses in the report are the edge's or empty, as in 5.1                                                                                                                                                                                                                                                     |
| out of scope, left as the browser leaves them in a worker    | `RTCRtpScriptTransform` and encoded insertable streams (the frames are in the worker already; a page's transform runs there in a later phase), `RTCIceTransport.getStats`, `RTCIdentityAssertion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Errors and their texts are copied from Chrome 152 and 156 as the suite
records them, the way `src/inject/errorMessages.ts` and the
`error-messages` suite do for the rewriter.

## 8. Media

### Send

`addTrack(track)` and `addTransceiver(track)` on the page's thread wrap the
track in a `MediaStreamTrackProcessor` (video) or one with `maxBufferSize`
(audio) and transfer its `readable` to the worker with the track's settings
(`width`, `height`, `frameRate`, `sampleRate`, `channelCount`). In the
worker:

- video: a `VideoEncoder` per encoding (one, or one per rid for simulcast,
  with `scaleResolutionDownBy` applied by `VideoFrame` cropping and the
  encoder's output size), configured with the negotiated codec
  (`vp8`, `vp09.00.10.08`, `avc1.42001f` constrained baseline packetization
  mode 1 as Chrome offers, `av01.0.04M.08`), `latencyMode: 'realtime'`,
  `bitrate` from the stack's estimate (`EgressBitrateEstimate` from
  transport-cc or REMB, scaled across layers as Chrome does), a keyframe
  forced on `KeyframeRequest` (PLI, FIR) and on a new layer; each
  `EncodedVideoChunk` goes to str0m's `Writer::write` with the pt and an
  RTP timestamp from the frame's timestamp at 90 kHz, and str0m packetizes
  (VP8 and VP9 payload descriptors, H.264 FU-A, AV1 OBU aggregation),
  paces and retransmits (NACK through its rtx streams);
- audio: an `AudioEncoder` with Opus at 48 kHz, 20 ms frames, the channel
  count of the track, `opus: { application: 'voip' }`, FEC and DTX as
  negotiated (`useinbandfec`, `usedtx` in the fmtp), audio level for the
  `ssrc-audio-level` extension computed from the `AudioData`;
  each chunk written with the 48 kHz timestamp;
- `replaceTrack` swaps the readable without renegotiation; a muted or
  ended track stops the encoder and str0m stops the stream (Chrome sends
  silence or nothing, matched per case);
- `setParameters` changes bitrate caps and active layers on the running
  encoders.

### Receive

A `MediaAdded` from the stack creates the transceiver's receiver and its
track: on the page's thread a `MediaStreamTrackGenerator` of the kind,
whose `writable` is transferred to the worker, and the `track` event with
the generator's track and a `MediaStream` carrying the signalled msid. In
the worker each `MediaData` (str0m's depacketized frame, with its jitter
buffer, reordering window and contiguity flag) goes to a `VideoDecoder` or
`AudioDecoder`; a video frame that is not contiguous after a loss asks the
stack for a keyframe (PLI) and the decoder waits for it; decoded
`VideoFrame`s and `AudioData` are written to the generator's writable with
their timestamps. Playout delay is the generator's and the element's; the
worker keeps a small target (`jitterBufferTarget` when the page sets it)
and drops late frames the way Chrome's renderer does. Audio and video of
one stream are kept in sync through the RTCP sender reports' NTP mapping
(str0m's `last_sender_info`).

Simulcast reception (an SFU forwarding one layer) is one decoder; the
layer switches are keyframes. `getSynchronizationSources` and
`getContributingSources` come from the RTP headers and the CSRC lists str0m
reports.

WebCodecs uses hardware encoders where Chrome has them and software ones
otherwise, the same pool `RTCPeerConnection` draws from; the cost is the
copy of each frame into the worker and back, which `VideoFrame` transfer
makes a reference, not a copy. The memory notes on per-frame inject cost
apply: nothing of this exists in a document that never makes a connection.

### Where audio can need an AudioWorklet

Not for the codec: `AudioEncoder` and `AudioDecoder` with Opus are in
workers. A page that reads the remote audio through the Web Audio API
(`createMediaStreamSource`) gets it from the generator's track as from any
track. If a measured case shows the generator's audio timing drifting
(the one place the probe cannot settle in advance), the fallback is an
`AudioWorklet` fed over a `SharedArrayBuffer` ring from the worker, which
the proxy origin's headers would have to allow (cross-origin isolation);
that is a risk entry, not a plan.

## 9. Where it runs, and how it talks

```
page realm                     rtc worker (one per document)              transport worker
RTCPeerConnection stand-in --> connection state, str0m instance,  --udp/tcp RPC-->  epoxy connect_udp /
  methods: records on a port   TURN client, timers, WebCodecs,                      connect_tcp / connect_tls
  events: records back         stream table (handle <-> port)                       (one wisp connection)
  tracks: readable/writable
    transferred
```

- The inject starts the rtc worker with the native `Worker` captured at
  load, on the `rtcWorker` asset URL built from `assetBase` (the proxy
  origin, so the worker is in the document's agent cluster and the
  transfers above are allowed), the first time a document constructs an
  `RTCPeerConnection`, and hands it a transport port (`requestTransportPort`,
  as `provisionWorkerTransport` does for a page's own workers) and the
  compiled module from the loader. Every connection of the document shares
  the worker; the worker ends with the document.
- Page to worker: one `MessagePort` per connection for calls and events
  (small records, structured clone), one per data channel for its messages
  (`send` posts the bytes, `message` events come back, `bufferedAmount` is
  mirrored by acknowledgements so a tight send loop reads a rising number
  as natively), and the transferred media streams.
- Worker to transport: `udp` and `tcp` calls on the transport RPC answer a
  `MessagePort` each; a datagram is one message with its `ArrayBuffer`
  transferred, as the HTTP/3 path moves QUIC datagrams through the
  transport worker today (docs/http3.md). The transport worker is the only
  holder of the wisp connection, so a document never loads a transport
  module and never sees a wisp URL, as now.
- The page's thread does nothing per packet. Per frame it does nothing
  either: the processor and generator streams run between the browser's
  media pipeline and the worker.

The rtc worker is a classic worker script (like `transportWorker.js`), its
own esbuild entry in `build.js`, its own `Assets` key (`rtcWorker`) and
renamable like every other asset. Its size does not count against
`injectDocument.js`; the stand-in in the inject does, and stays small
(the classes are declarative: the budget for the module is 40 KB of the
850 KB, measured by `frame-cost` as it measures everything). As built, the
stand-in's code is a file of its own too (section 15).

## 10. Threat model

- **No packet outside wisp.** No code in a page, the inject, the rtc worker
  or the transport worker opens a socket: the only network the rtc worker
  can reach is the transport port, which carries wisp streams. The
  browser's `RTCPeerConnection` is constructed by no one; the stand-in
  replaces it in every realm the inject covers (the realm list the current
  module and the `webrtc` suite enumerate: about:blank children, srcdoc,
  nested, blob:, data:, sandboxed frames, popups). The native constructor
  remains reachable only to the inject's own closures. Workers have no
  `RTCPeerConnection` natively and get none.
- **No address of the user anywhere.** The worker never learns one: the
  wisp server opens the sockets. What the page reads (candidates,
  descriptions, stats, errors) is generated from the stack's state, which
  holds the edge's addresses, `0.0.0.0`, and `.local` names.
- **No mDNS, no DNS, no LAN packets.** Names resolve on the wisp server;
  `.local` names resolve only through the same-browser bridge.
- **Realms.** The stand-in classes are installed per document realm with
  the realm's own prototypes, as the current module does per realm; an
  object of another document's realm is just that realm's stand-in.
- **A page's intrinsics.** The stand-in handles no secret (there is none
  to leak), so the hardening the current module needed for real addresses
  (null-prototype tables, own iterators, natives for string work) reduces
  to the usual rules: natives captured at load for anything the stand-in
  calls, promises of the page's realm for what it returns.
- **The wisp server's policy.** Destinations the server refuses (private
  ranges) fail; the server's egress address is what peers see. A server
  with UDP off leaves TURN over TCP and TLS.
- **Adjacent, out of scope here:** `WebTransport` is another API that
  sends from the network service and is not hooked today; it needs its own
  stand-in over wisp UDP (the QUIC stack of docs/http3.md is most of it)
  and is noted for a later plan.

## 11. Phases

Each phase ends with the gate (`npm run build`, `npx tsc --noEmit`,
`npm run lint`, `npx prettier --check .`, `npm run check:prose`), the full
suite set as CI runs it (`SKIP_NETWORK=1 SKIP_TIMING=1 SKIP_MEASUREMENT=1
PARALLEL=2 npm test`, failures rerun alone with `PARALLEL=1`), the `webrtc`
suite and the new suites, a Chrome 156 run of the touched suites, and a
commit on the branch with a CHANGELOG bullet.

**Phase 0 (this document).** The design; the toolchain request
(`wasm32-wasip1`, the per-crate target marker) to the Rust rewriter agent
whose Phase 0 provides `deploy/rust/`, `rust/`, the loader and the artifact
checks; the first container build of a `rust/rtc` crate that only
instantiates str0m, to measure size and prove the WASI shim.

**Phase 1. Data channels end to end with a real external peer.** The
crate's boundary and records, the STUN client, the TURN client (UDP first),
the rtc worker, the `udp` and `tcp` transport RPC, the stand-in with
`RTCPeerConnection`, `RTCDataChannel`, `RTCIceCandidate`,
`RTCSessionDescription`, the ICE events and states, the SDP renderer for
the application section, the same-browser bridge (the existing local checks
keep passing). Peers: a Node peer in the suite (`werift`, a pure JavaScript
WebRTC stack with data channels, run by the fixture and reached through the
demo's loopback-allowed wisp) and a native Chrome page in a second browser
context signalling through the fixture's WebSocket relay. The `webrtc`
suite's leak checks are rewritten for the new meaning (section 12) and stay
strict.

**Phase 2. Audio.** The media bridge, `AudioEncoder` and `AudioDecoder`
with Opus, `addTrack`, the `track` event, senders and receivers with
`replaceTrack`, audio level, the audio stats; a loopback call to the Node
peer (werift carries Opus through) and to native Chrome, with a measured
round trip and no drift over a minute.

**Phase 3. Video.** `VideoEncoder` and `VideoDecoder` for VP8, VP9, H.264
and AV1, keyframe requests, bandwidth estimation driving the encoders,
simulcast send, `setParameters`, `getDisplayMedia` and `canvas.captureStream`
sources (both are tracks; nothing differs), video stats.

**Phase 4. Stats, renegotiation and the rest.** The full `getStats` report,
`RTCRtpTransceiver` semantics (`stop`, `setCodecPreferences`, directions),
`negotiationneeded` timing, rollback and perfect negotiation, `restartIce`
and ICE restarts, `setConfiguration`, certificates (`generateCertificate`,
`certificates` in the configuration, `RTCCertificate`), `RTCDTMFSender`,
TURN over TCP and TLS, ICE-TCP, `RTCSctpTransport`, `RTCDtlsTransport`,
`RTCIceTransport` getters.

**Phase 5. Fidelity.** The `native-shapes` and `tells` additions for every
class, error texts recorded against Chrome 152 and 156, SDP line-by-line
parity, the realm matrix, live checks (browserleaks.com/webrtc shows the
edge's address, a public data channel echo and a public WebRTC test page
complete, Google Meet's pre-join screen shows the local preview and reaches
"connected" on a test meeting, Discord voice joins when its servers accept
the edge), Firefox as the remote peer (a native Firefox page in the suite
when a binary is available, else recorded), timing of events against
native where pages depend on it.

## 12. Tests

- **The `webrtc` suite's leak checks** assert today that the fixture STUN
  and TURN servers and the fixture remote candidate hear nothing. Through
  wisp they do hear from the demo's wisp server, which on the test machine
  is the same loopback address as the browser, so the check becomes: no
  packet from a socket of the browser's. The suite samples `ss -uanp` and
  `ss -tanp` for the ports owned by the Chrome process tree while each
  probe runs (every 100 ms; an ICE socket lives for the connection) and
  fails on a fixture packet from any of them; the native control shows
  Chrome's ports hitting the fixtures, as the precondition. The namespace
  recipe (`unshare -rn`, a dummy uplink, tcpdump; docs/webrtc.md) stays the
  packet-level proof and is rerun by hand for the report of each phase.
  Everything else in the suite (no address of this machine readable
  anywhere, every realm, the tampered-intrinsics probe, the API surface
  against native) stays and now runs against the stand-in.
- **`webrtc-peer`** (new): the Node peer and the native-Chrome peer, data
  channels both ways (ordered, unordered, `maxRetransmits`, `blob`
  `binaryType`, 256 KiB messages, `bufferedAmount` under a burst), the
  page as offerer and as answerer, trickle and non-trickle, a TURN-only
  connection against a fixture TURN server (a small UDP TURN server in the
  fixture with long-term credentials), an unreachable server's 701s with
  their timing, ICE restart, close from each side.
- **`webrtc-media`** (new, `--use-fake-device-for-media-stream`): an audio
  and a video call against each peer, frames decoded on the far side
  (werift reports RTP, the native Chrome peer reports `inbound-rtp`
  `framesDecoded`), `replaceTrack`, a muted track, simulcast layer counts,
  keyframes on PLI, bitrate following a capped estimate, stats fields.
- **`webrtc-sdp`** (new, no network): offers and answers recorded from
  Chrome 152 and 156 for each shape compared with the renderer's output
  with the identifiers normalised; remote SDP from Chrome, Firefox, Safari
  and the Node peer accepted; the error cases.
- **`native-shapes`, `tells`, `error-messages`** gain the WebRTC classes.
- **`frame-cost`** gates the inject's growth as it does for everything;
  a new `rtc-cost` measurement (SKIP_MEASUREMENT) reports the worker's
  startup, the module's compile and instantiate times, and the heap of a
  document with one connection open, so the lazy promise is checked.
- **`wasm-artifact`** (the rewriter agent's suite) covers `assets/rtc.wasm`
  through the same checks, with its own `abi.json`.

## 13. Size, memory and performance

- Nothing loads for a document that never constructs a connection: the
  stand-in classes are defined in the inject (tens of KB), the worker
  script and the module are fetched on the first construction.
- The module compiles once per controller through the loader and is posted
  compiled to each document's worker.
- One wasm instance per document, however many connections; its linear
  memory grows with the SCTP and RTP buffers in use (in the order of a few
  MB per media connection, measured in phase 3) and is released with the
  worker.
- Each RTP packet is one wisp frame, as each QUIC datagram is for HTTP/3,
  where docs/http3.md measured 5 to 8 MB/s on a loaded edge: a 2.5 Mbit/s
  video call is a tenth of that. The tunnel adds its round trip to the
  call's; the edges are near the user.
- WebCodecs' hardware paths are the same Chrome's `RTCPeerConnection` uses;
  software VP8 and Opus are cheap. Transfers of `VideoFrame`s between the
  page and the worker are references.

## 14. Risks

| Risk                                                                                  | Handling                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| the shared toolchain targets `wasm32-unknown-unknown` only                            | the `wasm32-wasip1` request to the rewriter agent (section 4); the custom-backend fallback is written down and costs a week, not a redesign       |
| std's panic strings or wasi-libc paths in the artifact fail the token check           | `-Zlocation-detail=none`, `-Zfmt-debug=none`, `build-std`, `panic = "abort"`; the check runs in `build.sh`, so nothing that fails it ships        |
| str0m's SDP parser rejects a real peer's SDP (Firefox, Safari, an SFU)                | the `webrtc-sdp` corpus; a parse error is reported as Chrome reports one, and the corpus grows with each real site that fails                     |
| the stand-in's state machines differ from Chrome's where a page depends on the timing | event order and state sequences are asserted against native recordings in the suites; timing is matched where a page is found to depend on it     |
| a page munges SDP in a way the stack cannot apply                                     | the presented description is the page's; what cannot be applied is ignored, which is Chrome's own direction; the limit is documented              |
| the wisp server refuses UDP, or rate-limits it                                        | TURN over TCP and TLS; the 701 path; `allow-udp` is on for the edges since 2026-11-10                                                             |
| a TURN server refuses the edge's address, or a service blocks data-center egress      | the same as for the rest of the proxy; reported, not solved                                                                                       |
| two restrictive NATs with no TURN                                                     | out of reach by design (section 2); the page's own `iceServers` are the answer, as for every user on a symmetric NAT                              |
| the audio generator's playout timing drifts                                           | measured in phase 2; the AudioWorklet fallback in section 8                                                                                       |
| werift as a test dependency                                                           | a devDependency only, pure JavaScript, pinned; the native-Chrome peer is the interop check and needs nothing new                                  |
| other agents land in `src/inject`, `src/transport` and `rust/` continuously           | rebase onto `origin/master` before every phase and before every gate run; the transport RPC additions are two new calls, nothing existing changes |
| Chrome 156 (CI) differs from 152 (here) in WebCodecs or stream transfer               | the capability probe is a suite precondition; the touched suites run on CI's Chrome before each phase lands                                       |

## 15. Phase 1 as built

A proxied page's `RTCPeerConnection` is STomp's: it negotiates with a real
peer and carries data channel messages both ways, every packet on a wisp
stream. The `webrtc-peer` suite holds it to that against three far ends, in
both demo modes: a peer in the suite's process (werift), Chrome's own stack
in a second browser, and another proxied page in that browser through a
TURN server.

### What works

- The page as offerer and as answerer, with candidates in the description or
  trickled, against werift and against Chrome.
- Channels: ordered and reliable, unordered with `maxRetransmits`, with
  `maxPacketLifeTime`, with a `protocol`, negotiated with an `id`; text,
  `ArrayBuffer`, views and `Blob`s out, `arraybuffer` and `blob` in; messages
  up to Chrome's 262144 bytes both ways with Chrome, and up to what the peer
  says it takes otherwise (a larger one is Chrome's `TypeError`).
- `bufferedAmount` rises with each `send` in a task, drains to zero, and
  `bufferedamountlow` fires at the threshold.
- An empty string and an empty binary message are delivered, in order on an
  ordered channel, as Chrome delivers them: one zero byte under the "empty"
  payload identifiers of RFC 8831 section 6.6, which the page's
  `bufferedAmount` and `bufferedamountlow` do not count (Chrome's do not).
  str0m 0.25.0 as published takes a stream sequence number for such a
  message and writes no chunk, which stalls an ordered channel at the peer;
  `rust/patches/str0m-0.25.0.patch` is the fix, applied in the container
  build (deploy/rust/README.md). werift cannot send an empty message (it
  writes a DATA chunk with no user data, which SCTP forbids), so the suite
  takes that direction from Chrome.
- An offer that is rolled back leaves nothing in the stack: its channels
  are offered again with the next offer and open. str0m 0.25.0 as published
  allocates a channel when it is added to an offer and never releases it
  when the offer is dropped, so a channel with a negotiated id panicked on
  the next offer (a wasm trap, which ends every connection of the
  document); the same patch file allocates at the answer instead, in the
  order the channels were made, so that the first has the lowest stream id
  as in Chrome. Chrome does not offer the section again: see the limits
  below.
- Closing: the end that closes a channel sees `close`, the other `closing`
  then `close`. `close()` on the connection ends the association with an
  SCTP ABORT whose cause is a User-Initiated Abort, "Close called", as
  Chrome's does, then sends the DTLS close_notify, so the peer's channels
  close at once. str0m as published started a graceful SHUTDOWN and closed
  DTLS at once, which dropped the SHUTDOWN: the peer heard only the
  close_notify, and werift kept its channels open (the str0m and sctp-proto
  patches of `rust/patches`). When the peer closes, the page's channels
  close at once and the connection reads `disconnected` 5 s later (Chrome:
  5.05 s measured).
- ICE: a host candidate at a `<uuid>.local` name, a `srflx` per STUN or TURN
  server (UDP) from a Binding request on a wisp stream, a `relay` per TURN
  server over UDP, TCP or TLS (long-term credentials, permissions and a
  channel per peer, refresh), `iceTransportPolicy: 'relay'`, the 701
  errors of servers that do not answer with Chrome's texts and timing,
  `restartIce()` and `createOffer({ iceRestart: true })`.
- TURN over TCP and TLS: the allocation travels on a wisp TCP stream to
  the server (`turns:` through epoxy's `connect_tls`, the TLS stack HTTPS
  uses, which checks the server's certificate as Chrome does), the
  messages framed as RFC 8656 section 12.5 says; the relayed address is
  UDP either way. What the page reads is Chrome's, measured on 152 and 156
  against the suites' TURN fixture over each: a `relay` candidate whose
  line says `udp`, `relayProtocol` `tcp` or `tls`, the server's URL
  (`turns:host:port?transport=tcp` for TLS), and Chrome's priority (type
  preference 3 for a UDP relay, 1 over TCP, 0 over TLS; local preference
  31 for the last TURN URL of the configuration and one more for each
  before it); errors with no local address (`hostCandidate` `:0`, and
  `0.0.0.x:0` for a TLS connection that failed on 152): a connection that
  fails is a 701 "Failed to establish connection", one that never comes up
  over TLS too after 30 s, one that never answers "TURN allocate request
  timed out." after 40 s, and refused credentials a 401 "Unauthorized."
  (over UDP as well; the stack wrote "Unauthorized"). Chrome tells the
  errors of TCP servers as gathering ends, however early they failed, those
  of TLS servers so too on 156 and as they come on 152, and those of UDP
  servers as they come; so does the stack. Through
  the proxy the TURN server hears the wisp server.
- ICE-TCP (RFC 6544): Chrome gathers a TCP candidate that connects out
  (`tcptype active`, port 9) and never signals it behind mDNS names, and
  connects to a peer's passive TCP candidate (an SFU's ICE-TCP; measured
  with werift offering nothing else, 152 and 156). The stack has one too,
  listed only in the stats report as Chrome's is, and its pair with a
  passive candidate is a wisp TCP stream with RFC 4571 framing. A
  candidate that only connects out (`tcptype active`) is given to no one,
  as Chrome connects to none.
- `getStats()` has Chrome's entries in Chrome's order (by id) with Chrome's
  members (the `webrtc` suite compares them with the browser's at each
  stage of a connection): `peer-connection` with the channels opened and
  closed, `data-channel` with its counters, `transport` with the ICE and
  DTLS roles and states, the selected pair and its changes, a
  `certificate` for each end (each connection makes its own, as Chrome
  does), `local-candidate` once the page could have heard of it (none
  right after `setLocalDescription`, as natively nearly always: Chrome's
  lists the host candidate there when its network thread gathered it
  before the report was taken, 2 times in 200 on 152 and never in 200 on
  156 in an idle page, so the suite leaves that one out of the
  comparison at that stage), `remote-candidate` (a
  peer reflexive one until the page adds the peer's own, which then takes
  its place) and `candidate-pair` with the checks, the round trip time and
  the bytes, all counted by the worker, which carries every datagram
  (`src/rtc/stats.ts`). The selected pair is the one ICE nominated. Host
  candidates read `address: ''` and `networkType: 'unknown'`, as Chrome's
  do behind mDNS names; a reflexive or relayed one is at the wisp server's
  address as the server saw it, with the server's `url`.
- `pc.sctp` is an `RTCSctpTransport` once a description has a data
  section, with its `RTCDtlsTransport` (the peer's certificate from
  `getRemoteCertificates()`) and `RTCIceTransport` (the gathered
  candidates, the selected pair, a peer reflexive one at
  `redacted-ip.invalid` as Chrome writes it), their states and events in
  Chrome's order, and the values Chrome gives where it gives little
  (`role` and the parameters null, no remote candidates). A gathered
  candidate's `url` is its server's (`stun:host:port`,
  `turn:host:port?transport=udp`), `''` for the host one; a restart's
  candidates are of the next `generation`.
- ICE reads as Chrome's: `iceConnectionState` is never `completed`, it is
  `checking` only once a pair has formed, gathering ends when the
  connection is up (what a server has not answered by then is never
  shown) and no sooner than Chrome's last gathering step (120 ms), and
  `icegatheringstatechange` comes before the end of candidates.
- An ICE restart the peer starts: its offer with new credentials is
  answered with new ones, the page gathers again (`gathering`, the host
  candidate of the next generation with the new `ufrag`, `complete`, the
  end of candidates) and the channels go on over the old pair until the
  new one is chosen. The connection reads `connected` throughout, as
  Chrome's does (156 in every run, with werift and with Chrome as the
  peer; 152 sometimes reads `disconnected` for a moment when the offer
  carries its candidates); the stack's agent says `checking` at a restart,
  which the page used to read, and is not told while connected. The same
  holds for a restart of the page's own. The agent drops every remote
  candidate at a restart, and a description set at once carries none of
  the new ones yet: the worker gives it the old ones back (without a ufrag
  of their own), which it checks with the new credentials, as Chrome finds
  the peer again where it was. Two of the stack's connections that
  restarted that way used to check nothing more and read `disconnected`
  once any pair was given up (two connections in one page, with a
  candidate nobody is at, 25 s on; through the packet capture's probe
  too, where Chrome's stay connected).
- The descriptions a page reads have Chrome's lines in Chrome's order for a
  data channel section (the suite compares an offer and an answer with
  Chrome's own, identifiers normalised), with the candidates gathered so
  far and the default candidate in `m=` and `c=`.
- Two proxied documents of one browser still connect without the network
  (section 5.4); two proxied pages in different browsers connect when the
  page names a TURN server (each is behind the wisp server as behind a
  symmetric NAT: section 2).

### Where it differs from the plan

- **The boundary.** The exports are `memory`, `_initialize`, `a`, `f`, `c`,
  `i`, `t`, `o`, `p`, `d`; the imports are `clock_time_get` and `random_get`
  of `wasi_snapshot_preview1` and nothing else (`rust/rtc/abi.json`). A
  record is a tag byte and a payload. Datagrams and channel messages are
  binary; control calls, their results and events are text fields
  (`key=value`, separated by 0x1f), which is enough while nothing on the
  path is per packet. The flat binary layout comes with media frames.
- **STUN and TURN are in the worker**, in TypeScript (`src/rtc/stun.ts`,
  `turn.ts`, `md5.ts`, HMAC-SHA1 from WebCrypto), not in the crate: they are
  timers and one stream each, and the worker already owns both. The crate is
  told a relayed address (`relay_candidate`) and transmits from it; the
  worker wraps those datagrams for the TURN server and unwraps what comes
  back.
- **The stand-ins are loaded when a document first uses them.** What every
  document carries (`src/inject/dom/modules/WebRTC.ts`) is
  `RTCPeerConnection`, `RTCDataChannel`, `RTCDataChannelEvent` and
  `RTCStatsReport` with the browser's prototypes, each member one that
  reads as the browser's and runs the member of the document that made the
  object, and those prototypes are proxies dressed the first time anything
  looks at them. What the classes do is the asset `rtcStack`
  (`src/inject/dom/rtcStack.ts`, `dist/rtcStack.js`): the first connection
  a document makes, or the first event of one of its channels, fetches it
  with a synchronous request (from the HTTP cache after the first) and
  evaluates it in the bundle's realm with the globals the bundle took when
  it loaded; the page reads no report and no resource entry of that
  request. What the library uses of the document is taken before any page
  script: the module takes the realm's constructors and objects it needs
  (`Promise`, `Worker`, `MessageEvent`, `setTimeout` and the like) when
  the document starts, and the members it calls (`postMessage` of ports
  and workers, `addEventListener`, `performance.now`) when the bundle
  loads, and the library's channels to its worker are made and heard with
  `src/transport/ports.ts`. A page that replaced or hooked these before
  its first connection is never handed a port or a message of STomp's, and
  its connection's promises are the browser's (`webrtc-lazy`). The WebRTC
  and media interfaces (`RTCRtpSender`, `MediaStreamTrack` and the rest)
  are the exception: they are read from the document when the library is
  installed, since the browser makes an interface's objects the first time
  it is named and taking them at the start would make them in every frame
  (about 12 KB of heap a frame for these, `frame-cost`). A page that
  replaced one of those globals, or one of their members, before its first
  connection has its own used for the library's objects, which natively it
  would not. Documents that reach each other share it and install it
  together. A document that never uses WebRTC pays what it did before
  (`frame-cost`), and the browser's own `RTCPeerConnection` (the format
  template of section 16) is made only by a document that does.
- **The module is loaded per document.** The rtc worker compiles
  `rtc.wasm` from its URL (`compileModule` of `src/wasm/module.ts`) the
  first time a document makes a connection; the HTTP cache makes later
  documents cheap. The shared plumbing hands compiled modules to the
  service worker and the rewrite workers and does not reach documents, so
  "once per controller" waits for it to.
- **The DTLS certificate** is made by the worker with WebCrypto (ECDSA
  P-256, a self-signed X.509 written by `src/rtc/certificate.ts`) and
  handed to the stack. Its serial is 64 random bits, as Chrome's, and
  every INTEGER is in the fewest bytes DER allows: the far end's parser
  (dimpl's, OpenSSL's) refuses a certificate with a padded one, and the
  handshake stops there. str0m's crypto backend makes one with rcgen on
  aws-lc-rs, which has no wasm build: `rust/vendor/str0m-rust-crypto` is
  the published crate without that feature.
- **The browser's `RTCPeerConnection` is not the validator.** (With media,
  section 16, a document makes one native connection as the template of
  its formats; it is given nothing that could make it gather.) What Chrome
  says to a bad configuration, a bad remote description, a bad candidate
  and a bad channel dictionary is produced by `src/inject/rtcValidation.ts`:
  the WebIDL conversions (members read in name order), Blink's checks of
  the ICE servers, WebRTC's parser of an ICE server URL, its parser of a
  session description and of a candidate line (the line and the words of
  "Failed to parse SessionDescription."), and its checks of a remote
  description (fingerprint, ICE credentials, BUNDLE, the order of the
  sections). All of it runs in the page's realm, synchronously where the
  browser's does (the old callback form of `setRemoteDescription` hears a
  parse error before the call returns). Chrome 152 reads `iceTransports`
  and wraps `maxRetransmits` and `maxPacketLifeTime`, and lets
  `setConfiguration()` change `alwaysNegotiateDataChannels`; 156 does none
  of the three.
  The stand-in asks the browser's constructor which it is with a
  configuration whose last member throws (no connection is made), and
  takes the answer for all three, since nothing but a connection could
  tell the others: Chrome 153 to 155 are unmeasured. A document holds 500
  connections, closed ones included until they are collected (weak
  references shared by the documents that share the tables), and the next
  is refused as Chrome refuses it ("Cannot create so many
  PeerConnections").
- **A peer that aborts.** When the peer ends the SCTP association with an
  ABORT chunk (what Chrome sends when a page closes its connection, and
  werift), each open channel gets `closing`, then an `error` event, then
  `close`, and reads `closed` already when the error is told, as Chrome's
  own does. The event is the browser's `RTCErrorEvent` with an `RTCError`
  of detail `sctp-failure`, `sctpCauseCode` 12 whatever the chunk's cause
  (as Chrome's stack reports it) and a message that words the cause:
  "User-Initiated Abort, reason=Close called" from Chrome, an empty one
  from werift (`src/rtc/abort.ts`). The stack reports the lost association
  without its cause, so the str0m patch keeps the first cause of an ABORT
  chunk as it arrives (`DirectApi::sctp_abort_cause`).
- **Offers Chrome takes and would not write.** An offer of no section is
  not the stack's to answer: the worker answers it with the session's
  lines alone, gathers nothing for it, and the next offer is the stack's
  first. A section without a name is named by its position, an offer
  without a BUNDLE group gets one for the stack and the answer shows none,
  a data section over `TCP/DTLS/SCTP` is read as UDP and answered as it
  was offered (`offerForStack` in `src/rtc/sdp.ts`). A remote offer over
  the connection's own offer rolls that one back first. Every offer says
  `a=setup:actpass`, a later one too. `negotiationneeded` waits for the
  operations under way and is dropped when an answer brought the data
  section it was for, and `canTrickleIceCandidates` reads the remote
  description (null without a section).
- **The same-browser bridge** carries the datagrams on the `$stomp$webrtc`
  BroadcastChannel itself, addressed by the `.local` names, without a
  brokered MessagePort and without a wait: a name no document of this
  browser holds is a remote that never answers.
- **Roles.** An answer to an `actpass` offer says `a=setup:active`, as
  Chrome's does: the stack would take the passive role, so the crate starts
  DTLS as the client first. The stack opens the SCTP association only as
  the DTLS client; RFC 8841 has both sides open it and browsers do, but
  werift and aiortc go by the ICE role and wait as the answerer, so for an
  answer that allows messages of 64 KiB or less (what those peers say) the
  crate opens the association itself. The stack then keeps 64 KiB as that
  peer's limit, which is the peer's own.
- **Streams.** A stream to a remote is closed when the agent has no pair
  with it any more: str0m prunes a pair it gave up on from its checklist
  without an event, so after each step the crate reads which remote
  candidates still have a pair from the host candidate
  (`DirectApi::ice_agent`, a line of the str0m patch) and says the list
  when it changes (`ev=remotes`); the worker closes the streams to the
  others. The stream DTLS travels on stays until DTLS moves, also when its
  pair is gone (an ICE restart drops them all). A remote that never
  answers is given up about 16 s after its first check (Chrome: 15 s,
  measured with the same three silent candidates), and the wisp server's
  socket for it closes then rather than with the connection. One the wisp
  server refuses or closes is not asked for again for 10 s.
- **States.** The agent has no "failed": a connection that is disconnected
  before it ever connected reads `failed`.
- **The peers in the suite** are signalled by the suite itself (it holds
  both ends), not by a WebSocket relay in the fixture. werift cannot resolve
  a `.local` name, so the suite takes those candidates out of what it hands
  werift, which then learns the page's address from the page's first check,
  as section 2 describes for every peer.

### Measured

- `assets/rtc.wasm`: 1505320 bytes, 516411 with brotli. This is the budget.
  `dist/rtcWorker.js`: 31842 bytes (10971 with brotli).
- A connection to the peer in the suite's process is `connected` about
  210 ms after the page's `createOffer`.
- `npm test -- webrtc-net`: the streams over a connection's life, counted
  as the wisp server's sockets connected to each remote: a connection to
  werift that is given three more candidates at UDP sinks that never
  answer has a stream to each (1 + 3), the sinks' three close about 19 s
  in while the channel goes on (1 + 0), and the last closes with the
  connection (0 + 0), in both modes.
- `npm test -- webrtc-peer`: the checks named above, both modes, with the
  far end's view of the page's address attributed to a process by
  `test/sockets.mjs`: always a socket of the demo's wisp server (or the
  TURN fixture's relay socket), never one of the browser's, and natively
  the browser's own. The TURN fixture hears only the wisp server.
- `npm test -- webrtc`: the leak checks with their new meaning (section 12),
  77 checks.
- Nothing is fetched before a document makes a connection; the first one
  fetches `rtcWorker.js` and `rtc.wasm`. `npm test -- rtc-cost` holds what
  that costs to ceilings, as `frame-cost` does for every frame: the sizes
  of `rtcStack.js`, `rtcWorker.js` and `rtc.wasm`; a document's first
  `createOffer()`, timed from its first `new RTCPeerConnection()` (the
  library, the worker, the module and the certificate), and a later one;
  each file fetched once; the compile of `rtc.wasm`; the worker's JS heap
  once it holds a connection, and what the renderer grew by. Measured on
  Chrome 152 and 156 at loads of 15 to 50: the first offer in 55 to 172
  ms (natively 3 to 188 ms: Chrome's own first offer starts its WebRTC
  threads), a later one in 10 to 60 ms (natively 0.7 to 4), the three
  files fetched in 3 to 60 ms from the local demo, the compile in 2 to 5 ms
  (V8 compiles lazily), the worker's heap 680 to 760 KB and the renderers
  23 to 28 MB more with one connection.
- The packet capture of section 12, with the browser in a network
  namespace of its own: through the proxy it sends TCP to the proxy and
  nothing else, no UDP and no mDNS, and the page's servers and candidates
  hear from the wisp server's namespace (docs/webrtc.md has the table).
- `dist/injectDocument.js` and a proxied frame's heap are what they were
  before the stand-in (`frame-cost`, measured side by side); the stand-in's
  code is `dist/rtcStack.js`, which a document loads when it first uses it.

### Limits of Phase 1

- **The local end of a TCP pair.** Chrome's report shows the selected
  pair of an ICE-TCP connection from a peer reflexive local candidate at
  the port its socket got; here it is the TCP candidate at port 9, as the
  stack has no socket of its own.
- **Media** came after Phase 1: audio is carried (section 16), video is
  not yet.
- **The stats report lists only the candidates the page was shown.**
  Chrome's lists a candidate for every socket it opened, also ones it never
  signals behind mDNS names (the IPv6 "any" address, TCP active ones at
  port 9), and which those are depends on the machine; the stack has
  neither. The entries of the sound are section 16's; video sections have
  none yet, and a sender's and a receiver's `transport` are still null.
- **DTLS 1.2.** The report's `tlsVersion`, `dtlsCipher` and `srtpCipher`
  are what the stack negotiated: `FEFD`,
  `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` and `SRTP_AEAD_AES_256_GCM`
  between two of its connections, where two of Chrome's negotiate DTLS 1.3 (`FEFC`, `TLS_AES_128_GCM_SHA256`,
  `SRTP_AES128_CM_HMAC_SHA1_80`). str0m has no DTLS 1.3.
- **An ICE restart keeps the host candidate's port.** Chrome opens new
  sockets for the new generation, so its restarted host candidate has a
  port of its own; here only the generation and the credentials change.
- **After a rollback of the first offer, Chrome never offers the data
  section again** (152 and 156, measured): `createOffer` gives a
  description with no `m=` line every time, the channels stay `connecting`
  and `negotiationneeded` fires after each return to `stable`. Here the
  next offer carries the section and the channels open.
- **A peer behind a restrictive NAT with no TURN server** is out of reach,
  by design (section 2).
- **libcurl has no datagram streams**: with that transport a connection
  gathers its host candidate and nothing else, and never connects.
- The socket attribution of the suites needs Linux (`/proc`, `ss -p`).

## 16. Media as built

Audio and video come in slices; this section grows with them. Sections 8
and 9 are the plan, and what is written here is what the code does.

### The crate's media records

The stack packetizes and depacketizes, the worker encodes and decodes, so
what crosses the boundary is whole encoded frames: one Opus packet, one VP8
frame, one H.264 access unit in Annex B (start codes, the parameter sets
with a keyframe), which is what `VideoEncoder` gives with
`avc: { format: 'annexb' }` and what `VideoDecoder` takes without a
`description`. The crate's tests (`rust/rtc/src/tests.rs`, run by
`deploy/rust/test.sh -p rtc`) wire two connections back to back and drive
every record through the exports.

Configuration fields of `c`, all optional (a connection without them is a
Phase 1 connection):

| Field    | Meaning                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codecs` | what the host encodes and decodes: entries `pt,name,clock,channels,fmtp` separated by a bar, which are a browser's `a=rtpmap` and `a=fmtp` lines in its order. `rtx` entries name the payload they repeat (`apt=`). The `red` entry over Opus is taken as 63 over 111, the browser's numbering. Payloads the stack has no format for (`ulpfec`, video `red`) are left out and never negotiated. |
| `exts`   | the header extensions: entries `id:uri` separated by a bar, a browser's `a=extmap` lines. Ones the stack does not know are left out.                                                                                                                                                                                                                                                            |
| `bwe`    | send-side bandwidth estimation, starting from this many bits a second                                                                                                                                                                                                                                                                                                                           |

So the payload types and extension ids are the browser's and nothing about
a browser version is compiled into the artifact.

Control calls (text, as in Phase 1):

| `op`           | Fields                                   | Meaning                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `media`        | `kind`, `dir`, `stream`, `track`, `rids` | a section the next offer adds; the result is its `index`, the section's name on both sides of the boundary. `stream` and `track` are its `a=msid`; `rids` are simulcast layers this side sends.                                                              |
| `direction`    | `index`, `dir`                           | what this side wants of the section. Every offer states it again, whatever the last answer left of it, as a browser offers the transceiver's direction.                                                                                                      |
| `stop`         | `index`                                  | the next offer stops the section                                                                                                                                                                                                                             |
| `remote_offer` | `sdp`, `dir0`, `dir1`, ...               | `dir<n>` is what this side wants of the offer's nth section. The stack answers a section with the offer's direction turned around; the crate narrows the offered direction first, so the answer is the browser's (`recvonly` for a section without a track). |
| `payloads`     | `index`                                  | what the section negotiated: `codecs` in the words of the configuration and in the peer's order (the first is the one to send), `exts`, and `dir`, the direction as negotiated                                                                               |
| `keyframe`     | `index`, `rid`, `kind` (`pli` or `fir`)  | ask the peer for a keyframe                                                                                                                                                                                                                                  |
| `bitrate`      | `min`, `desired`, or `reset`             | what the encoders send at least and would like to send, for the estimator's padding and probing                                                                                                                                                              |
| `red`          | `index`, `on`                            | redundant audio (RFC 2198) for what this side sends. Off until asked: a browser sends it only when the peer lists it first, and reads it always.                                                                                                             |

The results of `offer` and `remote_offer` carry `mids`, `index:mid` for
every section. An offer's sections are in the order their owners were made
(a media section before a channel created after it), as a browser's are.
`rollback` puts the sections of the offer back in line for the next one and
the directions back as they were. An `offer` while one is pending is the
same offer again when there is nothing new to say (a page that reads a
draft and then offers), and otherwise replaces it the same way. A channel
the page negotiated itself (with an `id`) keeps its stream id through both:
the stack allocates a channel when its offer is answered, not when it is
put in one (`rust/patches/str0m-0.25.0.patch`).

Events: `media` (`index`, `mid`, `kind`, `dir`, and `send_rids`,
`recv_rids` for simulcast) when the stack has a section, for both the
offerer and the answerer (str0m reports only the sections of an offer it
accepted; the crate reports the ones an answer confirmed); `media_changed`
(`index`, `dir`); `keyframe` (`index`, `rid`, `kind`) when the peer asks
for one; `bitrate` (`kind` `twcc` or `remb`, `bps`); `paused` (`index`,
`rid`, `paused`) when a stream the peer sends stops or starts.

Frames are binary. A frame to send is input kind 4:

```
[media u8][pt u8][flags u8][level u8][orientation u8][age ms u16][time u64][rid len u8][rid][bytes]
```

and a received frame is output tag 6:

```
[media u8][pt u8][codec u8][flags u8][level u8][orientation u8][time u64][rid len u8][rid][bytes]
```

`time` is in units of the payload's clock (48000 for Opus, 90000 for
video); `age` is how long ago the frame was captured, which makes the
wallclock the sender reports pair with the RTP time, and so lines audio up
with video at the peer. `level` is the audio level in -dBov for the
`ssrc-audio-level` extension, `orientation` the rotation as
`urn:3gpp:video-orientation` numbers it, 255 for neither. Flags: 1 a
keyframe (received frames; the stack reads it off the payload), 2 nothing
was lost before this frame, 4 the first frame after a silence, 8 a voice
is speaking. `codec` says what the payload type carries so the worker picks
a decoder without a table of its own. A frame the stack does not take (a
payload the section did not negotiate, a section that does not send, a
connection not up yet) is dropped and the call's status says so; frames
come too often to answer each with a record.

With these records `assets/rtc.wasm` is 1502987 bytes (515313 with brotli):
28825 bytes more than the Phase 1 artifact (11003 with brotli). The RTP,
packetizer and estimator code was already in the Phase 1 artifact, since
the stack reaches it from every datagram it reads; the growth is the
writer, the codec and extension configuration and the records themselves.

### Audio in the worker

The page keeps the tracks and the worker does the rest. For what a section
sends the page hands over a `MediaStreamTrackProcessor`'s `readable`, for
what it receives a `MediaStreamTrackGenerator`'s `writable`; both are
transferred, so the sound never crosses the page's thread again. Neither
class exists in a worker, and both do in a window, which is why the ends
are made on the page (measured on Chrome 152 and 156; WebCodecs exists in
both places).

What the stack may negotiate is read from the browser (`src/rtc/formats.ts`):
the page asks a native `RTCPeerConnection` it sets nowhere for an offer
with an audio and a video section, once per document, and posts it to the
worker (`{kind: 'template', sdp}`; the `init` message says one follows, and
connections wait for it). Its `a=rtpmap` and `a=fmtp` lines become the
stack's `codecs` field and its `a=extmap` lines the `exts` field, so the
payload types, the format parameters and the extension ids are this
Chrome's and no table of them is shipped. Every audio payload of Chrome's
is offered, in its order: G.722, which WebCodecs has neither an encoder nor
a decoder for, is written by hand (below). Without a template the stack
keeps its own formats.

The protocol (`src/rtc/protocol.ts`) grew by the requests `addMedia` (a
transceiver the page added: its handle, kind, direction and the stream and
track its `a=msid` names), `mediaDirection`, `stopMedia`, `sendTrack` and
`receiveTrack` (the two streams), by an answer to `setLocal` and
`setRemote` (the media sections as they are now: handle, mid, the
direction negotiated, and for `setRemote` what the peer's description says
of each: its direction and the streams and track of its `a=msid`), and by
the event `unmute` (a section's first frame arrived). A section the peer
offers first gets a negative handle from the worker. The stack tells of
such a section only when its media flows, so the worker names a direction
for every section of an offer it hands the stack (`dir<n>`, all of what is
offered), which has the stack number them at once.

Sending (`AudioSender`, `src/rtc/audio.ts`): the track is read whether or
not anything is sent, and encoded only while the section's negotiated
direction sends and the connection is up. The payload is the first the
section negotiated that can be encoded here, with the parameters of the
peer's own `a=fmtp` line (the stack keeps its own for a payload): Opus
through an `AudioEncoder` (20 ms frames, `voip`, one channel at 32 kbit/s
unless the peer's `stereo=1` asks for two at 64, `maxaveragebitrate`,
`useinbandfec`, `usedtx` and `cbr` as the peer states them), or G.711 by
hand (`src/rtc/g711.ts`: the track averaged down to 8 kHz, 160 bytes a
packet). Three things about Chrome's encoder shape the code, each measured:
it refuses input that is not exactly what it was configured for (so it is
made for the track's own rate, and channels are mixed here); its
timestamps are its first input's plus what it has made, whatever the later
inputs say (so a jump in the track's timestamps starts a new encoder, and
the RTP time jumps with it); and with `usedtx` it makes nothing during a
silence and does not count the frames it left out (so there the RTP time
follows what was fed, once that is five frames past the last frame sent).
Every frame carries its level (RFC 6464, from the power of what went into
it), the first after a break is marked as a talkspurt, and `age` is
counted from when the frame's first sample was read.

Receiving (`AudioReceiver`): Opus through an `AudioDecoder` (one output a
packet, in order, which is how a decoded frame gets its RTP time back: the
decoder's own timestamps are a count from its first input), with two
channels from the first packet whose first byte says stereo; G.711 by hand
and drawn out to 48 kHz. Decoded frames wait in a playout buffer
(`src/rtc/playout.ts`): it starts playing once two frames are held, plays
one frame per 20 ms on the worker's clock (corrected for timers that fire
late), plays silence for a frame that is not there when it is due, lets the
time stand still when nothing at all is held (which is how the delay grows
when arrivals vary more than it covers), jumps over a hole longer than
200 ms (a sender that left a silence out), drops a frame that comes after
its time, and, when it has stayed deeper than the spread of the arrival
times asks for over a hundred frames, gives up the quietest of the next few
frames without a gap. The track's time is a steady count of what was
written.

Measured in headless Chrome 152 with two connections of one worker joined
over the bridge of section 5.4 (a 440 Hz tone written to a generator track
sample for sample on one side, the receiving track read sample for sample
on the other): the tone arrives whole in both directions with no break in
its phase over 12 s, 30 to 60 ms after it starts, frames written every
20.2 ms (99th percentile 23.5 ms); the same through an `AudioContext`
(a `MediaStreamAudioSourceNode` recorded by a worklet); from a 44.1 kHz
track, from a stereo track (mixed to one channel, or sent as two to a peer
that asked), as PCMU and as PCMA, with `usedtx` across a 1.5 s silence,
and from the fake microphone device.

The `rtc-media-unit` suite checks these modules in node, without a
browser: the playout buffer on a clock of its own (a steady stream, a lost
frame, frames that swap places, a late one, arrivals that vary and settle,
a pause, a burst), G.711 against what Chrome's decoder gives for the same
bytes, the level, the formats read from the offers of Chrome 152 and 156
(`test/fixtures/rtc`), the sender's times against an encoder that behaves
as Chrome's was measured to (a break in the track, a stereo peer, a track
at 44.1 kHz, `usedtx`), and a tone sent as G.711 through two stacks back to
back and written by the receiver.

### Transceivers in the page

The stand-in has the browser's media objects: `addTrack`, `addTransceiver`,
`removeTrack`, `getTransceivers`, `getSenders` and `getReceivers`, the
`track` event, and `RTCRtpTransceiver` (`mid`, `direction`,
`currentDirection`, `stop()`), `RTCRtpSender` (`track`, `replaceTrack`,
`setStreams`, `getParameters`, `setParameters`) and `RTCRtpReceiver`
(`track`, `getParameters`), with Chrome's members in Chrome's order and its
errors. A sender's track goes to the worker as a
`MediaStreamTrackProcessor`'s readable; a receiver's track is a
`MediaStreamTrackGenerator` the worker writes into, muted until its first
frame, with Chrome's id and label, in the streams the peer's `a=msid` names.
`negotiationneeded` follows the specification's flag (Chrome's check of
it: no current local description, a channel with no data section, a
transceiver whose direction or `a=msid` the last description did not
state, an ICE restart) and waits for the operations under way.

Sections are named as Chrome names them: the stack takes the names the
worker gives (`SdpApi::name_mids`, a hunk of the str0m patch), which count
up from "0" past every number a description has used, so a section's name
in its packets (the MID header extension) is the one both ends read. The
media sections a page reads are written in the shape of the browser's own
offer (the template of the previous section): its payloads, format lines,
extensions and attribute order, the sender's `a=msid` and `a=ssrc` lines,
and an answer that names its sources the way the offer did.

`setCodecPreferences` reads the page's list as Blink converts it (an
`RTCRtpCodec` each, its members in name order) and checks it as Chrome
does, measured on 152 and 156 (`codecPreferences` in
`src/inject/rtcValidation.ts`): Blink's check of each media type (152 takes
`audio` and `video` in lower case only, 156 in any case) and of each format
line (parameters split at `;` and `=`, a line without `=` one unnamed
parameter), then WebRTC's: a list of nothing but retransmission,
redundancy, FEC and comfort noise is refused, and every entry must be one
of the browser's capabilities for the transceiver's kind (what its own
`RTCRtpSender` and `RTCRtpReceiver` say, compared by name in any case,
clock, channels and parameters); an empty list puts the browser's order
back. The worker writes each section of a description in that order
(`preferredFormats` in `src/rtc/sdp.ts`): a codec where it is preferred,
retransmission only when it is preferred and then after each codec it
repeats, redundant audio where it is preferred (156 drops it without the
codec it carries, 152 keeps it), a stopped section with every codec. An
answer lists what was offered in the page's order, and rejects a section
when it has none of it: port 0, out of the BUNDLE group, its transceiver
stopped at both ends. What is sent follows the descriptions, as natively:
each end sends the first codec of the other's description that it can,
so the offerer's preferences pick the codec both ends send and an
answerer's only what it receives. For that the stack offers every codec
again in each offer and takes each negotiation's codecs and order, and an
offer with nothing new is a negotiation like any other (`renegotiate` and
the narrowing of str0m 0.25.0, which kept what the first answer left for
good, in `rust/patches/str0m-0.25.0.patch`). The `webrtc` suite compares
the errors, offers and answers with Chrome's case by case, and
`webrtc-media` what each end sends with Chrome's own stack at the far end
(PCMU, then G.722 after the page prefers it and offers again, then an
answer).

The template is the one native `RTCPeerConnection` a document makes: with
no configuration, two transceivers and one `createOffer()`, closed at
once. It is never given a description, a candidate or a server, so it
gathers nothing and sends nothing (the `webrtc` suite counts every call on
a native connection that could). Every other connection of the page is
the stand-in's.

The `webrtc-media` suite runs two scenarios against Chrome's own stack in
a second browser, in both demo modes, each first between two native
connections as the control: the page offers a tone and a channel and the
far end answers with its own tone, then takes its track away and the page
stops its transceiver; and the far end offers, the page answers and later
offers one more transceiver. At every step the page's transceivers, its
events in their order and the descriptions it makes read as natively; the
tone arrives unbroken both ways, a paused sender sends nothing and a
replaced track is what is sent; the far end hears the page from a socket
of the wisp server, and nothing the page reads holds an address of this
machine.

### G.722 and a lost Opus packet

G.722 (payload 9) is `src/rtc/g722.ts`: the ITU-T G.191 reference codec
(STL `funcg722.c`) in integer arithmetic, operator for operator, so it is
bit-exact both ways. Checked against the ITU-T G.722 Appendix II test
sequences (17,216 codes, 67,264 sub-band samples), the STL's own vectors
(48,768 codes, 97,536 samples) and its encoder and decoder on 15 signals
and random code streams: no difference; `rtc-media-unit` keeps a sweep's
hashes from the reference. ffmpeg's encoder differs from the reference on
clipped full-scale input only (it leaves out a clamp of the band
signals). The sender sends it when the peer lists it before Opus: 320
samples at 16 kHz a packet, 160 bytes, which the stack counts at 16 kHz
and writes at RFC 3551's 8000 Hz clock; the receiver decodes it and
draws it out to 48 kHz. In `webrtc-media` the page sends G.722 to Chrome,
whose decoder plays it, when Chrome's answer lists G.722 first.

A lost Opus packet is rebuilt or concealed, as Chrome's NetEq does it. A
loss is a hole of one to five packets in the RTP times (not the start of a
talkspurt; a longer hole is a pause, and an Opus DTX sender sends every
400 ms). The sequence numbers do not decide it: Chrome sends padding
packets on the audio's sequence, with the last packet's time, and the
stack calls the packet after one contiguous whether or not a packet was
lost before the padding (measured: a tenth of the packets lost, and the
packet after a lost one read as contiguous a third of the time).

- In-band FEC: a sender with `useinbandfec=1` (Chrome's default) that
  hears of loss puts a second, coarser copy of each SILK frame (LBRR, RFC
  6716 4.2.4) into the next packet. NetEq decodes it with libopus's
  `decode_fec`, which WebCodecs cannot ask for, so `src/rtc/lbrr.ts`
  rewrites the copy as a packet of its own: an LBRR frame is coded with
  the syntax of a first frame coded independently, so its symbols are
  read with libopus's iCDF tables and written again with the same ones
  behind a header that says "voice, no copy" (the range coder and the
  tables, 1793 bytes, from libopus 1.5.2). Checked against libopus 1.5.2
  itself (an encoder with FEC on, every packet with a copy, a decoder
  given `decode_fec` against one given the rewritten packet, then both
  given the next four packets): bit for bit the same output for
  narrowband, mediumband and wideband SILK (voice, noise and a tone:
  1,656 copies). A hybrid packet (Chrome's voice at 32 kbit/s is
  fullband hybrid) carries its copy in its SILK layer, and NetEq's FEC
  decode runs CELT's concealment for the band above it, which no packet
  can ask for: the rewritten copy is wideband SILK only, 45.7 dB signal
  to noise against libopus's FEC decode for a voice (7.3 for the
  concealment), 67.9 for a tone (6.6), 7.1 for white noise (-0.7), and
  the CELT layer starts again in the packet after it. As in libopus,
  the copy is used only for the packet just before the one that carries
  it (the last of a burst; the others are concealed) and not after a
  CELT-only packet, where `decode_fec` conceals instead.
- Otherwise the receiver hands the decoder a frame of one byte for each
  lost packet (the last packet's first byte, code 0), which libopus
  takes for a lost packet, and Chrome's `AudioDecoder` passes it to
  libopus as one. Measured against libopus's own concealment, the output
  is the same.

The copy comes a packet after the packet it rebuilds, so an Opus stream
is held 20 ms longer in the playout buffer (its delay is 60 ms where the
arrivals are steady) and the rebuilt packet is there before its time.
The stack hands a packet after a lost one on at once (str0m would hold
the packets after a loss until 15 had come, 300 ms of Opus, waiting for
the lost one: `set_reordering_size_audio(1)`), and drops one that comes
after a later one was handed on, where NetEq would still play it in
time.

The stack's receiver reports carry the loss (RFC 3550's fraction lost
since the last report, every 5 s as Chrome's), which is what has Chrome's
encoder make copies at all. In `webrtc-media` the far end offers a tone
through a relay of the suite's that loses every tenth of its Opus packets:
the far end hears of the loss from the page (its `remote-inbound-rtp`
reads 10 to 16 percent), makes copies within about five seconds, and the
page then plays the tone with no break where the packets were lost, as
the browser's own connection does (with only the concealment the page's
tone dipped in 83 to 95 of its 5 ms windows over 3 s). The receiver's
`inbound-rtp` counts the copies as NetEq does: `fecPacketsReceived` the
packets that carried one, `fecPacketsDiscarded` those whose copy was not
needed, and a packet rebuilt from its copy is not in `concealedSamples`
(in that scenario 171 and 152 here, 155 and 133 natively).

### DTMF

Every audio sender has an `RTCDTMFSender` (`sender.dtmf`, the same object
on every read, before negotiation and after `stop()` and `close()`; a video
sender's is null): an EventTarget on the browser's own prototype, whose
members answer for it as the sender's do. Measured on Chrome 152 and 156
and done the same way:

- `canInsertDTMF` is true while the connection is `connected`, the last
  negotiation has the transceiver send (`sendrecv` or `sendonly`, whatever
  its `direction` says since) with a telephone-event payload among what it
  sends with (at any clock), and it is not stopped or closed. A track is not
  needed. (156 reads it true as soon as the transport is writable, a moment
  before `connectionState` says `connected`; here it waits for that.)
- `insertDTMF(tones, duration = 100, interToneGap = 70)` converts its
  arguments first (WebIDL `DOMString` and `unsigned long`, Chrome's
  messages), then throws `InvalidStateError` when `canInsertDTMF` is false
  and `InvalidCharacterError` for anything but `0-9`, `A-D`, `a-d`, `#`,
  `*` and `,`, then clamps the duration to 40 to 6000 ms and the gap to 30
  to 6000 as signed numbers (2^31 and up is the least), and sets
  `toneBuffer` to the tones in upper case, replacing what was left.
- The first `tonechange` comes in a task of its own (before a timer or a
  message the page queues after the call); each event's tone has left
  `toneBuffer` when it is told; the next comes duration + 2 x gap later
  (2000 ms + gap after a `,`; Chrome waits the gap once more after the
  tone's own gap, and reads that second gap as it is then), and an event
  with an empty tone ends the run. `stop()` or `close()` ends it with no
  event and leaves the buffer as it was.

Each tone is a request to the worker (`dtmf`: the transceiver, the tone,
its duration), and the worker puts it on the wire as WebRTC's
RTPSenderAudio does (`src/rtc/dtmf.ts`), measured with a werift peer that
logged every packet of Chrome's:

- The events go on the telephone-event payload of the lowest clock the
  section negotiated, whatever the send codec: with Opus and both 110/48000
  and 126/8000 negotiated, Chrome sends on 126.
- A tone starts with the next audio frame, at least 50 ms after the last
  ended, and its packets go out in place of the audio frames of its time:
  nothing for the first, then one packet per frame, all stamped with the
  first frame's RTP time, the first marked, the duration counted up on the
  audio's clock, volume 10. When the duration reaches the tone's length
  (counted on the event payload's clock) the report with the end bit goes
  out three times at once. So with Opus on 126 a tone of 100 ms is three
  end reports of 960 (120 ms at 8 kHz) after one frame, and one of 500 ms
  ends at 4800: Chrome's arithmetic, kept. Past 65535 units an event goes
  on in a new segment (RFC 4733, 2.5.2.3), as Chrome's does.
- The frames go through the frame records of the boundary like the audio's
  (input kind 4, the event payload's number, `FLAG_TALKSPURT` for the
  marker, no level), and str0m's telephone-event packetizer writes each
  as it is; nothing in the crate times them. A peer that has no track
  sends no frames, so no events either (Chrome's sender with
  `replaceTrack(null)` sends none, and its `tonechange` events come all the
  same).

Received events come out of the crate as frames of codec 6. Chrome's
receiver (NetEq) plays an event as its two tones in place of the sound of
its time, the column's tone 3 dB louder (-9.2 and -6.2 dBFS less the
event's volume: -19.2 and -16.2 for Chrome's 10), even where audio packets
go on arriving beside it; the receiver here does the same, a 20 ms frame of
the tones for each 20 ms the event's duration has grown, on the duration's
clock, with the audio frames of that time dropped. The `webrtc-media`
suite has Chrome play `159` to the page with Opus, and the page hears the
three digits in order, as the browser's own connection does (which plays
Chrome's events on telephone-event/8000 in pieces, their durations being
counted at 48 kHz). Where nothing else arrives (a pause in the audio, or
comfort noise) Chrome plays an event for 40 ms at most; here it plays all
of it.

### Statistics of the sound

`getStats()` has Chrome's entries of an audio call, measured on 152 and 156
with two connections of a page and a tone each way (the `webrtc-media`
suite compares a proxied page's report with the browser's member for
member): `outbound-rtp` once both descriptions are applied and the
section sends (before any packet), `inbound-rtp` once a packet came, a
`codec` for each stream (`C{I|O}T01_{pt}[_{fmtp}]`, the browser's lines for
the payload) and no other, `remote-inbound-rtp` and `remote-outbound-rtp`
once the peer's first report of each came (stamped with its arrival), a
`media-source` (`SA<n>`, numbered across the page as tracks are given to
senders) for each sender's track, and the connection's `media-playout`
(`AP`: in Chrome 152 once it has a transceiver of sound, in 156 once one
receives). Each entry's members are in Chrome's order (each dictionary's
own by name, the base's first), with Chrome's ids and the values it
gives. A sender's and a receiver's `getStats()`, and the connection's for
one of their tracks, hold their stream, its codec and the peer's report
of it, the track's source or the playout, the transport, its
certificates and its selected pair with the pair's candidates; nothing
before the stream is there; another track is Chrome's
`InvalidAccessError`. `replaceTrack(null)` leaves the stream and drops
the source (`mediaSourceId` reads `SA0`, as Chrome's), `close()` leaves the
connection's own entry alone.

Where the numbers come from:

- The packets and bytes of each stream, its header bytes, the losses and
  the jitter of a received one are counted off the wire: SRTP leaves the
  RTP header in the clear, so the worker reads each packet's as it
  carries it (`src/rtc/stats.ts`), and the payload is what is left after
  the header and the SRTP tag, as Chrome counts it.
- The peer's reception and sender reports are the stack's: a patch of
  str0m keeps each stream's last ones, when they came, how many came and
  the round trip times they gave (`StreamTx::remote_report`,
  `StreamRx::sender_report`), and the crate's `rtcp` call tells them
  (times as whole microseconds, so no float formatting goes into the
  artifact).
- The sound is the worker's (`src/rtc/level.ts`): the level, energy and
  duration of a sender's track from its first local description on, and
  of what a receiver plays, as WebRTC's `AudioLevel` counts them (the
  loudest 16-bit sample of each 10 ms, the level updated every eleventh
  block: a tone of amplitude 0.5 reads 0.500015 and adds 0.25 a second);
  what the receiver writes to its track at the decoder's rate (48 kHz for
  Opus, 8 kHz for G.711, 16 kHz for G.722), concealment included, with how
  long each frame waited in the playout buffer, what it aimed at, and
  what it gave up or came too late.

Limits: the stack sends no RTCP XR receiver reference time, so the peer
never answers it and `remote-outbound-rtp` has no `roundTripTime` (Chrome's
has one once its own report was answered); the reports come as the stack
sends them, not on Chrome's schedule (its first after about 2.5 s); the
playout is counted at 48 kHz, where Chrome counts at its output device's
rate (44.1 kHz with the fake device); what a receiver plays is counted as
long as its track takes the sound, whether or not anything plays it
(Chrome counts nothing for a track no element or context plays, and reads
no level behind a muted element), with no samples inserted to slow down
and the processing delay taken as the buffer's; a video section has no
entries yet; and after the only media section is stopped and
renegotiated Chrome drops the transport from the report and the
connection reads `new` again, where here the transport stays.

### Comfort noise

Chrome's sender, with G.711 or G.722 and CN (13) in the peer's description,
stops sending speech once its voice detector has heard 160 to 180 ms of
silence and sends a comfort noise packet every 100 ms instead (RFC 3389:
nine bytes, the level and eight reflection coefficients; digital silence is
`5e7f7f7f7f7f7f7f7f`), and marks the first speech packet after it. With
Opus it never does (`usedtx` leaves the silence out instead). The worker
does not send comfort noise (below).

Chrome's receiver plays the noise a packet describes from the packet's time
until speech comes again, whether the packet comes once or every 100 ms,
whatever the codec (Opus too) and whether or not CN was negotiated, about
2.6 dB below the level the packet states (-22.5 dBFS for level 20, -52.7
for 50, -63.0 for 60, measured on 152 and 156), shaped by the
coefficients, at the rate of the decoder before it: band-limited to 4 kHz
after G.711, white to 24 kHz after Opus. Without comfort noise its
concealment fades out in about 320 ms. The receiver here
(`src/rtc/cn.ts`) makes the noise the same way: white noise through the
coefficients' all-pole filter (the step-up recursion, as WebRTC's decoder
turns them into a predictor), scaled to the level less 2.6 dB, moving to a
new packet's description over a few 10 ms blocks, at 8 kHz after G.711,
16 kHz after G.722 and 48 kHz after Opus, placed on the audio's RTP clock,
and written where the playout buffer would otherwise write silence or
nothing. The `webrtc-media` suite has Chrome send the page PCMU and then a
quiet noise, which Chrome's sender turns into comfort noise packets, and
holds the level the page plays to the level the browser's own connection
plays.

Limits: the worker sends no comfort noise. With G.711 or G.722 and CN
negotiated it goes on sending encoded silence, as Chrome does when CN is
not negotiated; matching Chrome would take WebRTC's voice detector (its
GMM detector in `kVadNormal` mode, with its hangover) and its comfort noise
encoder (the level and an LPC analysis of order 8, every 100 ms), in the
worker as G.722 is, and neither is there.

Limits: audio only (video sections negotiate and their frames are
dropped); in-band FEC of a hybrid Opus packet is decoded as wideband
SILK, without the concealment of the band above it that Chrome's FEC
decode adds, and FEC copies of stereo or 40 and 60 ms packets are not
used (Chrome sends 20 ms, one channel unless asked); the worker's Opus
encoder makes no FEC copies of its own (WebCodecs has its
`packetlossperc` fixed when it is configured, Chrome's sender sets it from
the peer's reports); playout runs on the worker's clock, not the
sound card's, so a long call drifts against it by the difference of the
two clocks and the track's sink absorbs that; Chrome sends its DTMF
packets with no header extension and the stack gives them the section's
(the MID, the send time and the transport-wide sequence number), and a
page's own `dispatchEvent` of a `tonechange`, as every event the stand-ins
fire, is untrusted and runs no microtask checkpoint between listeners;
the worker sends no comfort noise (Chrome does with G.711 and G.722
when CN is negotiated: that takes WebRTC's voice detector and CN encoder);
the far ends in the suite are Chrome's own stack, not werift or a TURN
relayed proxied page. With codec preferences: once an answer has taken
Opus without redundant audio the stack offers no RED again (str0m keeps a
codec's RED payload from its first negotiation; Chrome offers it again); a
video codec the browser only receives (VP9 profiles 1 and 3, H.264 High
4:4:4, AV1 profile 1) is accepted in the list and never offered, where
Chrome offers it in a `recvonly` section; and a section an answer rejects
lists the preferred payloads in its `m=` line only, as Chrome's
`createAnswer()` writes it (its `localDescription` names them in
`a=rtpmap` lines as well).
