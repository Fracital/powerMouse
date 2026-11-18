### Performance

- The content blocker's engine is compiled from the lists in one of the
  controller's rewrite workers, not on the service worker's thread: the
  compile is one call of 220 to 280 ms for the default lists, during which
  every request of the open pages waited (a first visit, and each daily
  refresh of the lists). The service worker's longest stall in its first
  3.5 s went from 326 ms to 24 ms in the bench. Without a rewrite worker
  the service worker compiles it itself, as before.
