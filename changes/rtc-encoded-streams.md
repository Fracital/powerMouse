### Fixes

- A proxied page's WebRTC senders and receivers have the older encoded
  insertable streams: `createEncodedStreams()` answers, refuses and
  delivers frames as Chrome's does (it failed with NotSupportedError),
  and with `encodedInsertableStreams` nothing is sent or played until the
  streams are made. An encoded frame can be copied with
  `new RTCEncodedAudioFrame(frame)` or `new RTCEncodedVideoFrame(frame,
{ metadata })`, cloned, and posted to the page or another worker, as
  Chrome's can (each failed). webrtc-transform compares each with Chrome.
