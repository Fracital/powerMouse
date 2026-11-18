### Performance

- A script with no text (an external script, a module, an empty element)
  is no longer handed to the rewriter: a proxied top whose markup had one
  fetched and compiled the rewriter's wasm core module synchronously in its
  first task to rewrite nothing, 15 to 30 ms before its first paint.
  (empty-script-rewrite.)

### Fidelity

- An external module script's `text` reads back empty, as natively; it
  read back the module prologue the rewriter wrote for its empty text.
  (empty-script-rewrite.)
