### Fidelity

- A proxied WebRTC connection checks its pairs on Chrome's schedule
  (measured on Chrome 157): the pair it sends on 2.66 s apart while it is
  answered and every 62.5 ms once nothing has come for 2.5 s, so a call
  whose far end vanished reads disconnected and failed when Chrome's does
  (5 s and 15 s after the first unanswered check); a remote nothing
  answers at is checked 25 times in 15 s beside a working pair, and then
  given up. The stack's agent checked every 3 s, and a silent remote 9
  times in 16 s (webrtc-net, the rtc crate's tests).
