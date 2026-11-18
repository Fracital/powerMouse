### Performance

- The wasm rewriter makes a script's source key and the statement that
  carries its text to the access API in one pass over the text, eight
  bytes at a time, and writes a function's mark without the formatting
  machinery: the bench corpus (15 MB, 10 libraries) is rewritten in 7 to
  13% less time, every output byte for byte what it was.
