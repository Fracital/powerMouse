### Fixes

- A popup opened to another origin gets a SecurityError reading its
  opener's globals, `location` or `document`, as natively; it read them,
  having held its opener since its initial about:blank. (popup-opener suite.)
