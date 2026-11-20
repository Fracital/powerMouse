### Performance

- Scripts rewrite about 8% faster: the core module builds the rewriter's
  walk and its edits for speed, as it did oxc's parser (`rust/Cargo.toml`),
  with the import-cycle linker and the error printer still built for size.
  Over a corpus of 4,018 scripts from real sites (323 MB) a rewrite takes
  8.3% less time, the largest scripts (3 to 12.7 MB) 9.9% less, with the
  same output. `core.wasm` is 171,665 bytes larger (928,476; 287,536
  brotli), and a thread's first rewrite after compiling it takes about 1 ms
  longer. No bundle changes.
