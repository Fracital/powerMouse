### Fidelity

- A proxied call whose far end vanishes ends as Chrome's does (RFC 7675
  consent freshness, measured on Chrome 157): the connection reads
  disconnected 5 s after its first unanswered check and sends nothing but
  checks from then on, and 10 s later it reads failed (iceConnectionState
  stays disconnected) and sends nothing at all until the peer checks it
  again or ICE restarts, which connect it again as natively. The stack's
  agent decided for itself after 22 s, never failed, and went on sending
  media and retransmissions over the dead path, opening another stream now
  and then to a remote the wisp server refused. A peer that closes its end
  gets the same timing (webrtc-net).
