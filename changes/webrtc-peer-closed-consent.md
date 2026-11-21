### Fidelity

- A page's RTCPeerConnection whose peer closed its end reads disconnected
  about 5 s later, and failed 10 s after that, as natively, even when the
  peer answered one more connectivity check on its way out, or the last
  packets went on another pair. Either cleared the consent clock the close
  had started, and nothing started it again, so the connection read
  connected for good (webrtc-peer, Chrome closing its
  connection, failed on a loaded runner in one of the two modes each run).
