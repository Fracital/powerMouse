### Fixes

- Cloudflare's challenge frame on vimeo.com and figma.com reads its own
  origin's answers again, where its request was "blocked by CORS policy" in
  some loads. Turnstile reads the frame's `contentWindow` every few
  milliseconds, and a read of a frame's window injects it with the reading
  page's bundle. When the read came after the frame's document arrived and
  before that document's own shell ran, the shell kept the client the parent
  made, and that client made the document's requests with the parent's
  fetch: in the parent's realm, judged as the parent's origin. Such a client
  now makes them with the window's own fetch, taken when it was made, and
  so does a frame under it that sends its requests through it. And when the
  read came on the frame's initial about:blank, whose client the browser
  keeps for the frame's document, that client never read the document's
  service worker container (it must not read the about:blank's), so it took
  the document for one no worker controls: a worker it started got no
  transport, and a frame under it sent its requests through the parent. It
  now reads the container once the window shows the document.
  (frame-own-requests suite.)
