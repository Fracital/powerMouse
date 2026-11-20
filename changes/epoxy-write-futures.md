### Fixes

- A transport's workers no longer grow for every Wisp packet epoxy writes:
  since the carrier's sink settled epoxy's writes as they were made
  (promptSink), each packet left two wasm-bindgen closures and their heap
  slots behind for the worker's life. wasm-bindgen-futures keeps a
  JsFuture's closures after `then` returns, so a callback called inside
  `then` finds none to drop, and the pinned epoxy build watches every
  write in a JsFuture of its own. A shard on news sites grew 6 to 8 MB of
  JS heap a minute, and its wasm memory with it, until it was retired.
  The sink now settles at once only for a build that waits on the
  writer's `ready` (one without epoxy-tls 0075, which reads it before
  every write) and hands the others promises (prompt-sink-unit).
