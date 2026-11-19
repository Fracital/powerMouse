### Performance

- Epoxy's AES-GCM runs ring's bitsliced AES in 64-bit words, four blocks a
  batch, on wasm32, where it took 32-bit words and two blocks a batch
  (`deploy/epoxy/patches/ring`, the patch stomp-h3 already carried).
  AES-128-GCM, which every large site picks for Chrome's ClientHello, was
  more than half of the transport worker's time in a download, and one
  worker carries every TLS connection of the session: an HTTP/2 download
  over TLS through a local holyWisp went from 370 to 410 Mbit/s to 515 to
  580 Mbit/s on a Ryzen 9 7950X core (Chrome 157), the same constant-time
  code a 64-bit target runs.
