### Fidelity

- A fetch's or an XHR's response reads its `Link`, `Location` and
  `Content-Location` headers as the server sent them. The worker rewrote the
  URLs of every response's Link header to routed proxy URLs (and dropped
  its `integrity` parameters), every Location and every Content-Location,
  so a page read `<http://proxy/stomp/<id>/js:generic/...>; rel=preload`
  where Chrome hands it `</a.js>; rel=preload`. Chrome acts on a Link
  header only for a document's own response (measured on Chrome 157: a
  script's, a stylesheet's, an image's, a fetch's and an XHR's announce
  no preload), on a Location only for a redirect and on a Content-Location
  never, so a document's Link header and a redirect's Location are still
  rewritten and nothing else is. (link-readback suite, both modes, against
  native; headers suite.)
