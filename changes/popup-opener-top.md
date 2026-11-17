### Fixes

- A popup's `opener.top` is its opener's top, as natively; it was the popup
  itself, so a loop climbing `opener.top` to the first window spun for good
  and hung the renderer (WPT cookies' cookie-test.js). (popup-opener suite,
  natively against the proxy.)
