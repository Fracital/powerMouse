### Fixes

- A URL that does not parse (`http://:`), assigned to `location`
  (`location = url`), throws the browser's SyntaxError naming it, as
  natively, where the proxy resolved it first and threw URL's TypeError
  (`Failed to construct 'URL': Invalid URL`). (`location.href =`,
  `assign()` and `replace()` already did so.) (wpt-location suite.)
