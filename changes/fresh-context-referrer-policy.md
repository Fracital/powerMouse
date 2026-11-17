### Fixes

- A frame's navigation of itself to another origin carries its own
  document's referrer policy and its link's `rel=noreferrer` or
  `referrerpolicy`, as natively; it went out under its parent's policy, and
  a meta refresh under no-referrer or unsafe-url sent the origin only (WPT
  referrer-policy refresh-cross-origin, sandboxed-iframe-with-opaque-origin).
  (frame-referrers suite, natively against both modes; wpt-referrer-policy.)
