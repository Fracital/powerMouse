# WebRTC

WebRTC is the one network API a proxied page can use that never goes through
the service worker or the transport: the browser's own ICE agent sends UDP
(and TCP) packets from the user's machine, to addresses the page names.
Through the proxy that was a straight leak of the user's real address
(browserleaks.com/webrtc showed it on the live site and locally). STomp keeps
`RTCPeerConnection` the browser's own and makes it behave as it does on a
network that drops every UDP packet: no packet goes to a server or a
candidate the page chose, and no address of the user's machine reaches the
page. The hooks are in `src/inject/dom/modules/WebRTC.ts`; the `webrtc`
suite holds them to the measurements below.

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

The page's connection is the browser's, constructed with the page's own
configuration (so every error is the browser's), and then the browser is
pointed elsewhere before it can gather.

**Servers.** Each STUN/TURN URL the page gives becomes
`<scheme>:255.255.255.255:<port>` with a port of its own (one per server
address, so a STUN server that is also the TURN server is asked once, as
natively; a server on a system port gets a system port). Sending to the
limited broadcast address without `SO_BROADCAST` fails in the kernel with
`EACCES` (measured on Linux; BSD sockets and Winsock refuse it too, not
measured here), so nothing leaves the machine,
and the browser handles the failed send as it handles a lost packet: it
retransmits and times out exactly as above. The 701 events, their timing and
the gathering states are the browser's own, trusted events; the hooks only
read back the page's URL (`url` of the error event, of a candidate, of stats),
and redact `address`/`hostCandidate` to the form the browser uses without
media access. `getConfiguration()` returns the page's servers; a candidate
pool is held back while the page's servers are applied (a pool gathers at
once) and set again with the stand-ins; `setConfiguration` goes the same way.
`iceTransportPolicy: 'relay'` stays: the browser gathers nothing.

**Remote candidates.** Every remote candidate (from `addIceCandidate`, or an
`a=candidate` line of `setRemoteDescription`) passes through one gate: a
host name a connection of this browser showed a page is handed over (two
proxied pages can still connect, see below); any other address (an IP, a
host name, an unknown `.local` name) is handed over as `255.255.255.255`, so
the browser never sends a connectivity check (or a DNS or mDNS query) for it.
The page reads its own address back everywhere (`remoteDescription`,
`RTCIceTransport.getRemoteCandidates()`, the selected pair, stats); the
connection line follows the browser's own rule (webrtc's
`UpdateConnectionAddress`) over the candidates as the page sees them.

**Host addresses.** Where the browser shows a host candidate's real address
(the proxy origin has media access), the page sees a random `<uuid>.local`
name for it instead, in candidate events, `localDescription`, `createOffer`
output, `RTCIceTransport`, stats (`address: ''`, as natively without
access) and `relatedAddress`; a name handed back in `setLocalDescription` or
as a remote candidate is turned back into the address.

**Two proxied pages.** Each document gets its own mDNS names, and every
proxied document runs its own copy of the inject, so the copies share the
names they showed on a `BroadcastChannel` (`$stomp$webrtc`, by its native
name: a page's channel names are scoped to its origin and can never be that
one). A remote `.local` name nobody announced yet waits up to 200 ms for its
announcement before it is sent nowhere; while it waits, the connection's
later operations wait behind it, in order, as the browser chains them. Two
connections of one page, or of two proxied pages in frames, open a data
channel in both demo modes; the browser resolves the other's name with an
mDNS query on the LAN, as it always does between two connections of one
machine.

**What may become a name the gate accepts.** Only what the browser itself
reported: the candidate of a trusted `icecandidate` event (a page cannot
make its own event trusted), what `getLocalCandidates()`,
`getSelectedCandidatePair()`, the description getters and `createOffer`
return. Objects the page makes (`new RTCIceCandidate`,
`new RTCSessionDescription`, its own events) read back exactly as made and
never feed the gate, so a page cannot get a name for an address of its
choosing and then add it as a remote candidate. An object neither of these
(say, read through the members of another document's realm, whose inject
keeps its own tables) is shown with every address replaced by a name that
the gate does not accept. Stats are redacted by type, wherever they are
read.

**A page's own intrinsics.** Everything here that runs while the page
runs handles real addresses, so it uses only natives taken when the inject
loads (string search and slicing, WeakMap and promise methods), tables
without a prototype, and lists the browser reads through an iterator of
their own. A page that patches `String.prototype.split`,
`Set.prototype.has`, `Map.prototype.get`, `RegExp.prototype.exec`, the
array iterator or an `Object.prototype` getter for a dictionary member sees
none of those strings and cannot steer what the browser is handed (the
suite patches them, logs what they see and checks it).

**Realms.** The module runs in every document the inject covers: about:blank
frames (reached by `contentWindow` or `frames[i]`), srcdoc, nested, blob:,
data: and sandboxed frames, popups. Each hooked member also admits remote
candidates and points servers nowhere for a connection another document's
inject made, so borrowing `addIceCandidate` or `setConfiguration` from
another frame reaches nothing either.

## Measured through the proxy

`npm test -- webrtc` (59 checks): each probe runs natively (the control: the
fixture STUN server answers and hands the page a `srflx`, remote candidates
get checks), and through the demo in same-origin and isolated mode, in a
browser that shows mDNS names and in one with media access
(`--use-fake-ui-for-media-stream`, real addresses natively). With the build
before this change 26 of its checks fail (STUN and TURN fixtures get
requests, the page reads `srflx 127.0.0.1` and `192.168.1.23`,
`172.16.8.8`, `fd4a:67bb:666b::8`, remote candidates get checks, in every
realm).

The native controls are preconditions, not fixed outcomes: whether and how
the browser leaks depends on the machine, so a native run that does not
show a leak is reported as a `note:` line and the proxied checks, strict
everywhere, still run. Remote candidates the page chooses are added to a
connection with nothing else to check: on one that already has a working
pair, Chrome checks a late candidate at most every 480 ms or so, shared with
every other pair (5 to 7 checks in 3 s here, against 49 on a lone
connection), and GitHub's runner (Chrome 156, 4 vCPU) sent 0 or 1, which
failed the native control there.

Packets leaving the machine (network namespace, tcpdump on the uplink; the
page names `stun:10.9.9.1:3478`, `stun:8.8.8.8:19302`, a UDP TURN server on
10.9.9.1 and a TCP one on 8.8.8.8, a pool of 2, remote candidates on 10.9.9.1
and 8.8.8.8, then a local data channel, a cross-frame one and a connection in
every realm):

| Load        | Unicast packets                                              | Other                           |
| ----------- | ------------------------------------------------------------ | ------------------------------- |
| native      | 100 UDP to 10.9.9.1:3478, 50 to 8.8.8.8, 6 to the candidates | 25 mDNS, 5 IGMP/ICMPv6 (kernel) |
| same-origin | none                                                         | 23 mDNS, 1 kernel               |
| isolated    | none                                                         | 23 mDNS, 1 kernel               |

browserleaks.com/webrtc through the local demo (a browser without the test
resolver rules, as a user's): before, "Public IP Address 5.188.124.57" in
both modes; after, "-" in both, with RTCPeerConnection and RTCDataChannel
detected as supported. (Locally the demo's egress is the same machine, so the
"Remote IP" row is the same address either way; on the live site it is the
edge's.)

## Limits

- **mDNS on the LAN.** The browser announces each host name it makes on the
  local network (link-local multicast, carrying the random name and the
  address it stands for) and asks for a name when two connections of the
  machine connect. A page cannot choose where these go and nothing reaches
  a site, but they are packets outside the tunnel; a proxied page cannot
  avoid them without losing the host candidates every browser shows.
- **No peer outside the browser.** A connection to anything but another
  connection of this browser never opens, as on a network that drops UDP
  with no reachable TURN server. Sites that need a real peer (calls, game
  netcode, WebTorrent) fall back to whatever they do without WebRTC.
- **Timing differences.** A STUN host name that does not resolve fails
  quickly natively (no lookup happens here, it times out at 40 s), and an
  IPv6 server literal is asked only from IPv4 host candidates here, so the
  number of 701s can differ. TCP TURN fails at once here; natively it waits
  for the connection to fail, which depends on the network.
- **The real-address case.** With media access the page sees names where
  the browser would show addresses: what a browser without access shows. A
  frame of the isolated demo has no media access of its own, like any
  cross-origin frame.
- **Another document's tables.** A remote name announced by another proxied
  document's inject is known here after a BroadcastChannel round trip; a
  page that hands one over sooner than 200 ms after the other page read it,
  or across browser profiles, gets no connection (never a packet sent
  elsewhere). Another realm's `getConfiguration()` for a connection it did
  not make shows the servers that realm last set.

## Relaying through the proxy later

The browser's ICE agent sends its packets itself, from the network service,
so nothing in a page or a service worker can carry them over wisp. Two ways
remain:

1. **An operator TURN server** (recommended next step). The host gives
   STomp TURN servers of its own (coturn next to the wisp server on the
   holyWisp edges, short-lived credentials from the host page) and STomp
   forces `iceTransportPolicy: 'relay'` with those servers in place of the
   page's. The browser then sends only to the operator's server (which sees
   the user's address, as the wisp server already does), gathers no host
   candidates at all, and every page-chosen peer sees the edge's address,
   like HTTP traffic. Remote candidates could then be handed over as they
   are (the relay reaches them), so real peers work. The relay candidate's
   `raddr` (the user's public address) must stay hidden (the hooks already
   show `0.0.0.0`). STomp's side is small (a config field through the two
   config getters, `src/inject/Client.ts` and `src/server/rewrites.ts`, and a
   branch in `configure`); the server, its credentials and its bandwidth are
   the work, so it is not built yet.
2. **WebRTC in wasm over wisp UDP.** ICE, DTLS and SCTP in wasm (webrtc-rs)
   on a wisp UDP stream, the way stomp-h3 runs QUIC (docs/http3.md), with an
   `RTCPeerConnection` stand-in for data channels. It would keep the page's
   own servers and peers, but it is a reimplementation of the whole API
   surface (events, SDP, stats) and cannot carry media without an encoder
   and decoder of its own; far from small.
