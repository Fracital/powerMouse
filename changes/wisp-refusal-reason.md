### Transport

- An https request whose Wisp stream the relay refused fails at once with
  the relay's reason (`WispCloseReason(ServerStreamBlockedAddress, ...)`
  for a name it blocks, `ServerStreamConnectionRefused` or
  `ServerStreamUnreachable` for a destination that cannot be had) instead of
  a bare "tls handshake eof" about a second later: epoxy's wisp stream read
  the CLOSE's reason from the wrong side and never had one while the
  connection lived on (deploy/epoxy patch epoxy-tls 0085), so
  RevivingTransport took every refusal for a throttled stream and sent it
  four more times. A throttled stream (0x49) is still tried again. This was
  https://raw.githubusercontent.com/ failing in test runs, whose relay blocks
  the content blocker's list servers, while https://cdn.jsdelivr.net/
  answered: not a TLS fault (`wisp-refusal` and `reviving-transport`
  suites).
