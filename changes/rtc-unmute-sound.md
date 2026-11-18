### Fixes

- A proxied page's received audio track unmutes when its first sound is
  written to it, as Chrome's sound follows its `unmute` within a few
  milliseconds, not when the first packet comes and 42 to 45 ms before
  the sound. A page that listened from `unmute` heard the decoder's first
  few milliseconds of near-silence and its edge, which `webrtc-media`'s
  unbroken-tone checks read as breaks of phase and, on loaded CI
  runners, failed on.
