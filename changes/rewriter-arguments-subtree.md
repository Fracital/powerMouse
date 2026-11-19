### Performance

- The rewriter asks whether a function's `arguments` may be rebound of
  that function's own part of the tree, reached directly, where it walked
  down to it from the top of the script past every function beside it:
  Discord's 12.7 MB main bundle, a webpack table of thousands of modules,
  is rewritten in about a fifth less time. The output is unchanged.
