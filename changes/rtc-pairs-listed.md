### Fidelity

- A proxied WebRTC connection that never connects reads as Chrome's does:
  `iceConnectionState` and its ICE transport `disconnected` and
  `connectionState` `failed` (it read `failed` for all three), at the turn
  that gives up its pair, and `checking` as the candidate is added (it was
  64 to 80 ms late). getStats lists a candidate pair only while the agent
  has it, `waiting` before its first check, and drops it and its remote
  candidate when it is given up (they stayed for ever, in progress); the
  transport's `iceState` then reads `failed`. Covered by webrtc-net.
