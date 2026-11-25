### Performance

- Tor mode's client starts from its kept state faster: a later visit was
  ready in 1.25 to 1.39 s and is now in about 1.05 s (Chrome, this
  machine). tor-js's IndexedDB storage answered a prefix by reading every
  key and value of the store (8.5 MB, some 9,500 microdescriptors), and a
  start did that three times for two small values and the consensus; the
  client now reads a prefix by a key range. The relay check no longer reads
  and parses the kept consensus before the client starts, nor at each of
  the two or more times arti keeps it: it takes the consensus arti reads
  back and parses it once, at the first link. The Wisp WebSocket opens
  while the client loads its state. A first visit is unchanged (1.7 to
  2.4 s, the directory download). (docs/tor-over-wisp.md "Bootstrap from
  the kept state", test/tor-kept-state.mjs.)

### Security

- Tor mode's client no longer hands arti a kept consensus past its
  valid-until. arti reads a cached consensus's times from the signed
  document, and its tolerance for clocks that are off (DirTolerance) can
  take one after it, building paths over relays the network may have
  dropped since. A later visit then downloads a new consensus and keeps
  the certificates, the microdescriptors and the guards; the expired one is
  deleted. (test/tor-kept-state.mjs.)
