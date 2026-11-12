# WebRTC

WebRTC is the one network API a page can use that never goes through a
service worker or a transport: the browser's own ICE agent sends UDP (and
TCP) packets from the user's machine, to addresses the page names. Through
the proxy that was a straight leak of the user's real address
(browserleaks.com/webrtc showed it on the live site and locally).

A proxied page therefore never drives the browser's `RTCPeerConnection`. Its
`RTCPeerConnection` is a stand-in (`src/inject/dom/modules/WebRTC.ts`) over
STomp's own WebRTC stack, which runs in a worker next to the page and sends
every packet on a wisp stream, as the page's fetches travel:
docs/webrtc-over-wisp.md has the design and what is built. This document
keeps what the browser's own stack was measured to do, which the stand-in
is held to, and what the `webrtc` and `webrtc-peer` suites check.

## What the browser does natively

Measured with headless Chrome 152 and a regular Chrome user agent, a page on
`http://127.0.0.1`, a STUN server that answers, UDP sinks that only listen,
and, for the packet counts, Chrome in a network namespace whose only uplink
is a dummy interface with tcpdump on it (`/tmp/stomp-webrtc` on the machine
the work was done on).

| What the page does                                  | What leaves the machine                                                                    | What the page reads                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new RTCPeerConnection()`, a data channel, an offer | an mDNS announcement of the host name on the LAN (multicast)                               | one host candidate per interface as `<uuid>.local` (one name per address and document), `c=IN IP4 0.0.0.0`; stats show `address: ''`                                                                                         |
| names a STUN server                                 | Binding Requests from the user's address (9 per server and host candidate when it is mute) | a `srflx` candidate with the public address (`5.188.124.57` here), in events, SDP (also `c=`) and stats                                                                                                                      |
| names a STUN server by host name                    | a DNS lookup of that name through the user's resolver, then the above                      | the same                                                                                                                                                                                                                     |
| names a TURN server                                 | a Binding Request and Allocate requests (UDP), or a TCP/TLS connection                     | a `relay` candidate; without an answer two `icecandidateerror` 701s                                                                                                                                                          |
| adds a remote candidate (an IP, a host name)        | STUN connectivity checks to it about every 190 ms (a DNS lookup first for a host name)     | the candidate in `remoteDescription` and stats                                                                                                                                                                               |
| has camera or microphone access                     | the same                                                                                   | host candidates with the real addresses (`192.168.1.23`, `172.16.8.8`, `fd4a:...`), in events, SDP, stats; `icecandidateerror.address` as `172.16.8.x`. Every proxied site shares one origin, so one grant shows them to all |

`RTCPeerConnection` is not exposed in workers (dedicated, shared, service);
`RTCDataChannel` is, and carries no address. `webkitRTCPeerConnection` is the
same function. `createOffer` resolves with a plain `{ sdp, type }`; each
`RTCStatsReport` read makes a new object.

### A network where UDP is dropped

This is what the page should see, so it was measured as the browser does it
(a STUN/TURN server that never answers):

- host candidates as above (mDNS names), at once;
- for each STUN server and each host candidate, `icecandidateerror` with
  `errorCode` 701, `errorText` "STUN binding request timed out.", `address`
  `0.0.0.x` (`[0:0:0:x:x:x:x:x]` for IPv6), `hostCandidate` `0.0.0.x:<port>`
  and the server's URL, about 39.9 s after gathering began;
- a TURN server over UDP adds a 701 "TURN allocate request timed out." about
  60 ms later (its address is also asked as a STUN server, so it adds a STUN
  701 too); over TCP or TLS a 701 "Failed to establish connection" with
  `address` `null` as soon as the connection fails;
- a TURN server on a system port (below 1024, but 53, 80 and 443) gets no
  allocation and no error;
- gathering completes with the last of these (40.0 s); no `srflx` or `relay`
  candidate, ever.

## What STomp does

**The page's connection is STomp's.** `RTCPeerConnection`,
`RTCDataChannel` and the events around them are classes of STomp's own
that read as the native ones. The first connection a document makes starts
a worker (`rtcWorker.js`) that loads the stack (`rtc.wasm`: ICE, DTLS and
SCTP, sans-IO) and is handed a port to the transport. The worker opens a
wisp UDP stream for each remote address the stack sends to; nothing in the
page, the inject or that worker can open a socket.

**Servers.** A STUN server the page names gets a Binding request from the
wisp server and the page gets a `srflx` candidate with the wisp server's
address as the STUN server saw it (the edge's, in a deployment). A TURN
server over UDP gets an allocation with the page's credentials and the page
gets a `relay` candidate. A server that does not answer gives the 701
errors above, with the browser's texts and timing; `getConfiguration()`
returns what the page set.

**Remote candidates.** A remote candidate at an address gets the stack's
connectivity checks from the wisp server, and the peer learns the page's
address from the first of them (a peer-reflexive candidate: the wisp
server's socket for that stream). A candidate at a `.local` name is another
proxied document's of this browser, or nobody's: the name is never looked
up, on the LAN or anywhere.

**Host addresses.** The stack has none: the wisp server opens the sockets.
The page's host candidate is a random `<uuid>.local` name, what the browser
shows without media access, whether or not the proxy origin has it.

**Two proxied pages.** Two documents of one browser exchange their
datagrams on a `BroadcastChannel` (`$stomp$webrtc`, by its native name: a
page's channel names are scoped to its origin and can never be that one),
addressed by the names they showed, without the network. Two proxied pages
in different browsers are each behind the wisp server as behind a symmetric
NAT, and connect when the page names a TURN server.

**The browser's own connection is never constructed.** The errors of a bad
configuration, a bad remote description, a bad candidate and a bad channel
dictionary are STomp's own reading of them (`src/inject/rtcValidation.ts`),
in Chrome's words: the suite runs some 600 such calls natively and proxied
and compares them case by case, and counts the connections the browser
itself makes for a proxied page (none). The same tables hold what Chrome
does with the offers it takes although it would not write them (no
section at all, a section without a name, no BUNDLE group, a data section
over TCP/DTLS/SCTP, an offer over the connection's own offer): the answer,
the states and events on the way, and the next offer. A document holds 500
connections as in Chrome, the closed ones counted until they are
collected; the next is refused with Chrome's `UnknownError`.

**Realms.** The module runs in every document the inject covers:
about:blank frames (reached by `contentWindow` or `frames[i]`), srcdoc,
nested, blob:, data: and sandboxed frames, popups. A member borrowed from
another document's realm is that realm's stand-in.

## Measured through the proxy

`npm test -- webrtc` (77 checks): each probe runs natively (the control: the
fixtures hear the browser's own sockets) and through the demo in same-origin
and isolated mode, in a browser that shows mDNS names and in one with media
access (`--use-fake-ui-for-media-stream`, real addresses natively). The
fixtures (a STUN server that answers, sinks that only listen) do hear
packets through the proxy now, from the demo's wisp server, which shares
the machine with them. What they must never hear is a socket of the
browser's: the suite samples which process holds which port while the
probes run (`ss`, test/sockets.mjs) and attributes each packet a fixture
got. Nothing a page reads may hold one of the machine's addresses, the 701
errors and the API surface read as natively, and a data channel opens
between two connections of one page and between two proxied pages in
frames.

`npm test -- webrtc-peer` (55 checks): a proxied page connects to a peer in
the suite's process (werift), to Chrome's own stack in a second browser and
to another proxied page there through a TURN server, as offerer and as
answerer, with trickled candidates, relay only, across an ICE restart, with
messages up to 256 KiB both ways. What each far end sees as the page's
address is a socket of the wisp server (or the TURN fixture's relay), and
the TURN fixture hears only the wisp server.

The native controls are preconditions, not fixed outcomes: whether and how
the browser leaks depends on the machine, so a native run that does not
show a leak is reported as a `note:` line and the proxied checks, strict
everywhere, still run. Remote candidates the page chooses are added to a
connection with nothing else to check: on one that already has a working
pair, Chrome checks a late candidate at most every 480 ms or so, shared with
every other pair (5 to 7 checks in 3 s here, against 49 on a lone
connection), and GitHub's runner (Chrome 156, 4 vCPU) sent 0 or 1, which
failed the native control there.

Packets, with the browser in a network namespace of its own (a veth pair
to the namespace that holds the demo, the fixture and a werift peer; a
dummy uplink and tcpdump in each). The page names `stun:10.9.9.1:3478`,
`stun:8.8.8.8:19302`, a UDP TURN server on 10.9.9.1 and a TCP one on
8.8.8.8, a pool of 2, remote candidates on 10.9.9.1 and 8.8.8.8, then a
local data channel, a cross-frame one, a connection in every realm and,
through the proxy, a data channel to the peer with a message each way:

| Load        | From the browser's namespace                                                 | From the wisp server's namespace                                  |
| ----------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| native      | 100 UDP to 10.9.9.1:3478, 50 to 8.8.8.8:19302, 25 to the candidates, 52 mDNS | nothing                                                           |
| same-origin | TCP to the proxy and nothing else: no UDP, no mDNS                           | 66 UDP to 10.9.9.1:3478, 33 to 8.8.8.8:19302, 6 to the candidates |
| isolated    | TCP to the proxy and nothing else: no UDP, no mDNS                           | 66 UDP to 10.9.9.1:3478, 33 to 8.8.8.8:19302, 6 to the candidates |

The browser's own stack announces each host name it makes on the LAN
(mDNS); a proxied page's connection makes no such name in the browser, so
those packets are gone too.

## Limits

- **What Phase 1 does not carry**: media, TURN over TCP and TLS, ICE-TCP,
  most of `getStats()`. docs/webrtc-over-wisp.md section 15
  lists them.
- **A peer behind a restrictive NAT, with no TURN server.** The page's
  packets leave from a socket the wisp server connected to one address, so
  only peers that answer where they are asked connect directly (servers,
  SFUs, peers behind a cone NAT). The page's own `iceServers` are the
  answer, as for every user behind a symmetric NAT.
- **Timing differences.** A STUN host name that does not resolve fails
  quickly natively; here the wisp server resolves it and the request times
  out at 40 s when it does not. TCP TURN fails at once here; natively it
  waits for the connection to fail, which depends on the network.
- **An offer with a section Chrome rejects.** Chrome answers an offer
  whose section names a protocol it does not know, or that has a second
  data section, with that section rejected (port 0) and keeps the rejected
  section in its later offers. The stack refuses such an offer whole:
  `setRemoteDescription()` rejects with `InvalidAccessError`, "Failed to
  set remote offer sdp: " and the stack's reason.
- **A remote description reads back as it was set.** Chrome writes it out
  again in its own form (a name for a section without one, `t=0 0`, no
  group but BUNDLE); `remoteDescription.sdp` here is the page's text with
  the candidates added since.
- **After a rollback.** Chrome drops the transport of a first offer that is
  rolled back, by `setLocalDescription({type: 'rollback'})` or by a remote
  offer over it: `iceGatheringState` returns to `new` and the next
  description has new ICE credentials. Here the transport, its candidates
  and its credentials stay.
- **The real-address case.** With media access the page sees a name where
  the browser would show addresses: what a browser without access shows.
- **libcurl.** That transport has no datagram streams: a connection gathers
  its host candidate and nothing else.

## Before the stack

The first fix (2026-11-10) kept the browser's own connection and sent it
nowhere: each server and each remote candidate was handed to the browser as
`255.255.255.255`, a send the kernel refuses, so the browser behaved as on
a network that drops UDP and a proxied page connected to nothing outside
its browser. An operator TURN server was the other way considered; section
1 of docs/webrtc-over-wisp.md says why the stack replaced both.
