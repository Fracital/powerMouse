### Fixes

- A URL attribute whose value is no URL throws nothing, as natively. The
  hooks that route `href`, `src`, `action` and the rest resolve the page's
  value against its base, and for one that does not parse (`https://[`,
  `//[]`, a port out of range, a host the URL standard refuses, any
  relative URL under `<base href="about:blank">`) the parser's TypeError
  reached the page: from `img.src = value`, `a.href = value` and
  `setAttribute`, from the `appendChild` of such a form, link or module
  script, from an `innerHTML` or a `document.write` that held one, and from
  the property's getter. The element now keeps the value as written, which
  the browser cannot load either: the property reads back as the
  attribute, a script or an image fires its `error` event from a task, a
  frame goes to `about:blank#blocked`, an `srcset` routes its other
  candidates, a link's URL parts answer as the browser's do for no URL
  (`''`, and `':'` for the protocol, never the proxy's own address), and a
  click on such a link opens nothing. A link made only to take a URL apart
  (`a.href = input; a.hostname`) no longer throws, and under such a base
  every script's `src` read no longer throws (testharness.js reads it for
  each stack). (web-platform-tests natively against proxied:
  wpt-url-elements' a-element and toascii pages, and the script element's
  fetch-src/failure.html, src-empty-or-invalid-error-event-queued.html and
  script-onerror-insertion-point-2.html.)
