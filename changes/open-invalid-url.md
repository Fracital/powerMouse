### Fidelity

- `XMLHttpRequest.open()` and `window.open()` throw the browser's SyntaxError
  for a URL that does not parse, as Chrome does: `open()` threw nothing (the
  stand-in kept the URL as a string until `send()`) and `window.open()`
  threw URL's TypeError. `open()` now resolves its URL there, against the
  document's (or worker's) base as it is then, so a `<base>` inserted after
  `open()` no longer changes where the request goes. 373 more WPT subtests
  pass (`url/failure.html` in `wpt-url-elements`,
  `xhr/open-url-base-inserted-after-open.htm` in `wpt-xhr-request`).
- `XMLHttpRequest.getResponseHeader()` answers null for a name that is no
  header name (`"x-custom-header "`, `"a:"`), as Chrome does, where it threw
  `Headers`' TypeError (`xhr/getresponseheader-special-characters.htm`).
