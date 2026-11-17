### Fixes

- A static `import` whose specifier the URL parser reads as an absolute URL
  but is written with a tab, newline or carriage return in it, or with
  leading or trailing spaces or control characters (`ht\rtp://host/x`), is
  now routed by the rewriter instead of being taken for a bare specifier
  and loaded from the site direct, as the dynamic `import()` form already
  was (`adversarial-parse-url`).
