### Build

- The codec module's bytes (`assets/codec.wasm` as text) are a deferred
  part of the document bundles (`src/wasm/codecBytes.ts`), in the rewriter
  library's file a proxied top's shell loads before its bundle: the top
  compiles its instance from it at its first seal, as before, and the
  frames under it seal in that instance and carry no copy. A document whose
  realm does not hold the parts already (a frame of another slot, a top
  whose shell did not load them) seals in JavaScript, the same bytes, and
  asks for no file for it. The worker bundles and the service worker keep
  their copy.
