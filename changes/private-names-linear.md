### Performance

- The rewriter's early-error check looks a class's private names up in a
  hash map instead of a list: a class of 8000 private fields took 65 ms to
  rewrite, and now takes 4 ms.
