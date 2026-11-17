### Fixes

- A request the page aborts before the origin's headers come no longer has
  its whole body received for nobody. The page's abort reaches the service
  worker as a message (Chrome never fires a fetch event's signal), and the
  answer that came after it was dropped without being cancelled, so the
  transport went on receiving it: wisp has no flow control towards the
  client, and epoxy kept every byte in the transport worker's wasm memory,
  which never shrinks (four aborted 128 MB downloads grew it by 370 MB;
  aborted fetches are everyday traffic on single-page apps). The same held
  for an answer that came after the worker had answered 504. Both are
  cancelled now and the origin's connection closes, as natively.
  (abandoned-bodies suite.)
