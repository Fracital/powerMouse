### Transport

- Epoxy opens on `epoxy.wasm` when `epoxy-simd.wasm` cannot be loaded. The
  SIMD128 build was the only module the ESM bundle asked for wherever the
  engine has SIMD128, so a host that ships the package's files under names
  of its own and left the SIMD file out (a 404), answers it with its HTML
  fallback page, or refuses the request had a transport that never opened
  and no page that loaded. The bundle now checks the answer, warns once in
  the console naming the file, and loads `epoxy.wasm`, as an engine without
  SIMD128 already did (a CPU without SSE4.1, where V8 refuses SIMD128).
  `epoxy-simd.wasm` is still the file to ship for speed. It is
  EpoxyTransport 0063 in deploy/epoxy; the pinned epoxy-transport build has
  it (EpoxyTransport dist 2a7a4c5, `epoxy-simd-fallback` suite).
