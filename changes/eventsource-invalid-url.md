### Fixes

- `new EventSource()` with a URL that does not parse throws the browser's
  `SyntaxError` DOMException ("Cannot open an EventSource to '...'. The URL
  is invalid."), in pages and workers. The constructor hook resolved the
  URL first and threw `URL`'s TypeError, which a page that catches the
  DOMException by name or code did not expect. (wpt-eventsource.)
