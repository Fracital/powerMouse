### Fixes

- A page's fetch of a Request made with a body and `mode: 'no-cors'` or
  `keepalive: true` goes as natively. The fetch hook handed its copy of the
  Request on as the init, so the browser took the body as a stream, which
  a no-cors or keepalive request may not have: the fetch threw where Chrome
  sends the bytes (npr.org's GeoEdge reports, a no-cors POST of a Request).
  Such a body now goes as its bytes. (request-bodies suite.)
