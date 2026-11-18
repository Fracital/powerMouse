### Fidelity

- Epoxy's ClientHello offers its X25519 key share with a key of its own, as
  Chrome's does: it reused the classical half of its X25519MLKEM768 share,
  so a server saw the same 32 bytes twice in every proxied connection and
  never in a native one. HTTP/3's QUIC ClientHello likewise.
  (epoxy-request-fields suite.)
