### Fixes

- `Response.textStream()` of an opaque response (the page's own service
  worker reading another site with `mode: 'no-cors'`) is an empty stream, as
  natively: it read the other site's body, which every other reader of an
  opaque response already hid. (sop-escapes suite.)
