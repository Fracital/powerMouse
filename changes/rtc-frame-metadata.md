### Fixes

- A proxied page's encoded transforms read each frame's metadata as
  Chrome gives it: a received sound's `sequenceNumber` is its packet's
  (it counted from a random start), a sent picture's `width` and `height`
  are the size it was encoded at and a keyframe's `type` is `key` (they
  read 0 and `delta`), and a received keyframe has the size its VP8, VP9
  or H.264 bytes state (it read 0). A browser receiving the page's VP9
  reads its keyframes' size, which the packets now state as Chrome's do.
  The new webrtc-transform suite compares the metadata with Chrome's own,
  per codec.
