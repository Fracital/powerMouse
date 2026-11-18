### Fixes

- foxnews.com's static templates load again. Its template frame of
  static.foxnews.com asks for them with jQuery's `$.ajax`, which adds
  `X-Requested-With`, while an ad-safety script on the page reads every new
  frame's `contentWindow` before its document loads. That read left the
  frame's document with no controller in Chrome 157, so its requests went
  through the top's realm and the worker judged them as the top's: cross
  origin, preflighted, and refused when static.foxnews.com answered the
  `OPTIONS` with 403. The fix of frame-kept-window covers it.
  (frame-template-xhr suite.)
