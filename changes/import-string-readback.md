### Fidelity

- An `@import` written with a string (`@import "a.css" screen;`) reads back
  as the page wrote it. The route keeps the page's string after `#url(` as
  a url()'s does, so a style's text and markup show the page's string, with
  its own quotes, and the rule's `cssText` shows `url("a.css")` as Chrome
  serialises it; the route showed in all three before. An `@import ""` is
  not routed (natively it loads nothing; it loaded the page itself as a
  stylesheet). assets/core.wasm is rebuilt. (style-text suite.)
