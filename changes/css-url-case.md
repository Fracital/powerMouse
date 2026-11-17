### Fidelity

- A URL written in CSS any way but a plain lower-case closed `url()` token,
  set on an element through its style (a named property, `setProperty`,
  `cssText`, `setAttribute('style')`, a CSS rule's style, the Typed OM) or as
  a `FontFace` source, is now routed: an upper-case `URL(...)`, a token left
  unclosed at the end of the value, and `image-set()`/`src()` forms all take
  the declaration parser instead of only a literal lower-case `url(`, so the
  browser no longer loads them from the site direct
  (`adversarial-parse-css`).
