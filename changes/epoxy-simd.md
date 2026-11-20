### Performance

- One origin's download through epoxy is about a third faster, where the
  transport worker's one core was the limit: about 870 Mbit/s against 650
  through the local holyWisp kit on loopback (headless Chrome 157), where
  AES-GCM was some 80 % of the worker's time. Epoxy now ships a SIMD128
  build beside the plain one (`epoxy-simd.wasm`), taken where the engine
  has SIMD128 and bulk memory, whose AES encrypts eight blocks at once in
  the same constant-time code. It is the same Rust, so the TLS ClientHello
  and everything else on the wire are unchanged. Needs the epoxy build with
  ring 0002, epoxy-tls 0083 and epoxy-transport 0062.
