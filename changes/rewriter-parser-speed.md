### Performance

- core.wasm builds oxc's parser at opt-level 3, everything else still for
  size: scripts are rewritten in about 11% less time, for 123 KB more of
  core.wasm (25 KB more brotli).
