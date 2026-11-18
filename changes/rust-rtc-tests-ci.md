### CI

- CI runs the WebRTC stack's own Rust tests (`cargo test -p rtc`, a `rust`
  job in the pinned Rust image, about 3 minutes from cold beside the
  browser suites), which nothing ran before: a change to the stack's
  configuration (patch 10's hand-on of late audio packets) had left
  `audio_both_ways` failing unseen. The test now asserts that a late
  audio packet is handed on and a repeated one is dropped.
