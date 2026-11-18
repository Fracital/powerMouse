### Fixes

- A proxied page's video senders take `scalabilityMode` as Chrome's do:
  WebRTC's modes are taken, others refused with Chrome's errors, and a
  mode the codec cannot do reads as L1T2 once a description is set. The
  pictures go out in the mode's temporal layers with the dependency
  descriptor, a simulcast sender with no modes sends as Chrome's does,
  and a far end's layered video plays. Encoded transforms read each
  frame's `frameId`, `dependencies`, `spatialIndex` and `temporalIndex`
  as in Chrome (they read 0 for the layers before).
