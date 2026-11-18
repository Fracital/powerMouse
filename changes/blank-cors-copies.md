### Fixes

- A document no service worker controls (a frame's initial about:blank,
  where ad and widget code writes its markup) loads another origin's CORS
  resources that allow any origin again: a stylesheet's font faces, a
  `crossorigin=anonymous` image or script. The copies the inject fetches
  for such a document were sent with credentials whatever the load, so an
  answer with `Access-Control-Allow-Origin: *` (Google Fonts', most CDNs')
  failed its CORS check and the font, image or script never loaded
  (target.com had 54 Google Fonts requests refused in one frame). Each copy
  now sends credentials as its load does natively: a no-cors load and a
  `crossorigin=use-credentials` one include them, any other CORS load sends
  them to its own origin only. (blank-cors suite.)
