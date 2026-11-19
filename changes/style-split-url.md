### Fixes

- A url() that a page splits across a style's Text nodes loads as natively,
  so the icons of Google's app launcher stay. The launcher's template writes
  `url('`, the address and `')` as three Text nodes when it renders its
  style again a second after the tray opens; each piece was routed on its
  own, the first was closed where it ended, the address landed outside the
  url(), and the browser dropped the declaration. A piece that leaves a
  url() open now lands as the page wrote it, and its style's rules are
  routed by the CSSOM pass before anything paints. The Text nodes, the
  style's text and its rules read back as natively. (style-text suite.)

### Known limitations

- An `@import` whose url() a page splits across a style's Text nodes still
  does not load through STomp: the browser fetches an import as it parses the
  text, before the CSSOM pass could route it, so that piece is routed on its
  own as before (no request goes past the proxy).
