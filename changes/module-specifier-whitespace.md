### Fixes

- A dynamic `import()` of a specifier that the URL parser reads as an
  absolute URL but is written with a leading space or a tab, newline or
  carriage return in its scheme (`ht\rtp://host/x`) is now routed instead of
  being treated as a bare specifier and fetched from the site direct
  (`adversarial-parse-url`).
