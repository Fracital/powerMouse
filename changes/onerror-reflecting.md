### Fixes

- `document.body.onerror` (and a frameset's) is the window's `onerror`, as
  natively. The window's handler is kept behind a wrapper that gives it the
  page's URLs, and only `window.onerror` knew: `document.body.onerror` read
  after `window.onerror = f` returned the inject's wrapper (its source text
  readable through `toString()`), a handler set through the body was not
  what `window.onerror` read, and with a `<body onerror="...">` attribute
  `window.onerror` read null. (wpt-event-handlers suite.)
