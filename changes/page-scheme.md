### Demo and API

- Proxied pages are light or dark as the demo's theme is, and Settings
  has Page appearance (Match theme, Light, Dark), Chrome's mode for the
  pages. Match theme is dark for Default and Dark, light for Light, the
  system's for Follow system and the frame's for a Web Store theme. The
  demo gives its frames that `color-scheme`, which Chrome 157 gives a
  frame's document as its `prefers-color-scheme` (measured for a frame of
  the same origin and of another, nested frames and a change while open),
  so `matchMedia`, `@media`, `<picture>` and `light dark` pages answer as
  in Chrome in that mode, and an open page changes at once with one
  `change` event. The choice is `localStorage['stomp-demo:page-scheme']`.
  The frames' background is `Canvas`: a dark page in the Dark theme was
  white under white text (page-scheme suite).

### Fidelity

- `Sec-CH-Prefers-Color-Scheme` on a navigation `frame.go()` makes is the
  preference the frame's document reads (its element's `color-scheme`),
  not the host page's own, in both controller modes and with the site
  pool (page-scheme and client-hints suites).
