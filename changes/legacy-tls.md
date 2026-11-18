### Fidelity

- STomp now reaches the TLS 1.2 servers Chrome reaches with the older
  suites in its ClientHello: TLS_RSA_WITH_AES_128/256_GCM,
  TLS_RSA_WITH_AES_128/256_CBC_SHA and TLS_ECDHE_RSA_WITH_AES_128/256_CBC_SHA.
  Epoxy offered them, as Chrome's hello does, but failed with
  SelectedUnofferedCipherSuite when a server picked one.
  pro.ip-api.com (geoguessr's geolocation), cs.pgammedia.com,
  sync.pinklion.io and cs.playdigo.com pick AES-CBC-SHA from Chrome's
  offer: they answered native Chrome, but never STomp.
  - TLS still ends in the browser, so holyWisp relays only ciphertext, and
    the first hello is still Chrome's.
  - Nothing Chrome refuses is added: no 3DES, TLS 1.0 or 1.1, SHA-1
    signatures, P-521 or other CBC suites. An RSA key-exchange key is taken
    from 1024 bits, Chrome's floor.
  - The certificate checks are as strict as before. The end entity's
    keyUsage is now also checked as Chrome checks it: a certificate whose
    keyUsage does not allow the key's use in the handshake is refused
    (Chrome's ERR_SSL_KEY_USAGE_INCOMPATIBLE), where STomp connected.
  - ServerHellos that Chrome refuses are refused too: a non-empty
    renegotiation_info, and a TLS 1.2 random ending in the TLS 1.1 or JDK
    11 downgrade sentinel.
  - CBC records are opened in constant time, as BoringSSL opens them.
    (legacy-tls suite, against Chrome 157; deploy/epoxy patches rustls 0053
    and 0054, epoxy-tls 0064.)
