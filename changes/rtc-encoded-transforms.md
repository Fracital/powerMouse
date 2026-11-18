### Fixes

- A proxied page's encoded transforms work: `sender.transform` and
  `receiver.transform` take an `RTCRtpScriptTransform`, whose worker gets
  each frame the stand-in's connection sends or receives on its
  transformer's streams, as `RTCEncodedAudioFrame` and
  `RTCEncodedVideoFrame` objects with Chrome's metadata, and what it writes
  back is what is sent or decoded. The stand-ins took a transform and did
  nothing with it, so an end to end encrypted call (Discord's, which needs
  one) connected and sounded like noise: the page's sound went out
  unencrypted, and the far ends' encrypted frames were decoded as Opus.
  The new webrtc-audio suite measures calls through the proxy against
  Chrome's own (delay, segmental SNR, spectral distance, missing sound,
  pitch, speed) and has a Discord-shaped call. `createEncodedStreams()` is still
  refused (docs/webrtc-over-wisp.md, section 16).
