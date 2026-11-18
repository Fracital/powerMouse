### Performance

- What a proxied page sends in a call comes as soon after it was captured
  as natively when its track is at a rate Opus does not have (44.1 kHz,
  as many microphones and sound cards are, and 22.05, 32 or 96 kHz): the
  worker makes it 48 kHz itself (src/rtc/resample.ts) before WebCodecs'
  Opus encoder, which converted such a rate itself and held each frame 10
  to 40 ms, unevenly. Measured through the proxy against Chrome's own
  call: 74 to 89 ms from capture to the far end's track before, 51 to 55
  after, natively 43 to 54, and the far end's jitter 1 ms in place of 6.
  The webrtc-audio suite sends one capture as a 48 kHz and a 44.1 kHz
  track at once and checks the far end hears the second as soon after the
  first as natively (21 to 34 ms later before, -13 to -1 after).
