### Performance

- The rewriter's wasm core module is asked for by its hash
  (`core.wasm?<hash>`), as the rewriter library is, and the demo server
  lets browsers keep it for good under that hash: a proxied top's
  synchronous fetch of the module in its first task is answered by the
  HTTP cache instead of a revalidation round trip to the host (61 to 20 ms
  over a 40 ms link). (core-module-cache.)
