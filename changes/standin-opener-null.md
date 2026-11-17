### Fixes

- `opener` of a window nobody opened, read through STomp's stand-in for a
  window of another origin, is null as natively; it was the page's own top,
  so a climb through `opener` never ended and hung the renderer (WPT
  cookies' cookie-test.js). (popup-opener suite.)
