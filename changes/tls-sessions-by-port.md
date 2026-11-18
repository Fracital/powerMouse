### Fidelity

- TLS sessions are kept as Chrome keeps them: by host and port, at most
  1024 per network partition, with the least recently used dropped first.
  Before, a connection to another port of a host offered that port's TLS
  1.3 PSK or TLS 1.2 ticket, and one port's TLS 1.3 ticket could stand in
  for the TLS 1.2 session another port would have resumed. Every
  ClientHello also carries Chrome's two key shares (X25519MLKEM768 and
  X25519). Epoxy sent only the group a host last agreed on, which cost a
  HelloRetryRequest Chrome never needs at a server that takes
  X25519MLKEM768 alone. (legacy-tls suite; deploy/epoxy patches rustls 0055
  and epoxy-tls 0065.)
