### Fidelity

- STomp now takes the RSA keys Chrome takes: 1024 to 16384 bits, counted
  exactly, for a leaf, an intermediate or a root, under the public roots
  and under a page's own. Its verifier checked RSA signatures by keys of
  2048 to 8192 bits only, so it refused servers whose chain had a 1024 to
  2040-bit key or one over 8192 bits, which native Chrome reaches.
  - A key under 1024 bits is still refused (Chrome's ERR_CERT_WEAK_KEY),
    and so is one over 16384 bits.
  - Chrome 157 sets no 2048-bit floor under the Chrome Root Store, so
    STomp sets none either.
    (legacy-tls suite, against Chrome 157; deploy/epoxy patch epoxy-tls
    0072.)
