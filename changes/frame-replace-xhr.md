### Fixes

- bankofamerica.com's fraud-detection frame posts to its own origin again.
  porte.js makes the frame with `src` about:blank and sends it on to
  iconnectmx.html on dull.bankofamerica.com from its `contentWindow`'s
  location, which STomp does in a fresh context whose real `src` is the
  route. The check that keeps a frame's initial about:blank from reading
  its service worker container while a navigation is pending read the
  frame through the page's hooks: `frameElement` answered null for a frame
  of another origin and `src` read back about:blank, so the container was
  read, the frame's document was often left with no controller in Chrome
  157, and its XMLHttpRequest with `X-Embedding-Uri` went through the top's
  realm, was judged as www.bankofamerica.com's, preflighted and refused.
  The check now reads the element and its attributes with the browser's
  own getters. (frame-replace-xhr suite.)
