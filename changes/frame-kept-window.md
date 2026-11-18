### Fixes

- A frame's requests are its own after the page read the frame's initial
  about:blank before its document loaded (Vimeo's player.js does, for every
  player it embeds). Every proxied document is of the proxy's origin, so
  Chrome keeps that about:blank's window for the frame's document, and with
  it the hooks the parent put on it: they sent the document's fetches and
  XMLHttpRequests through the parent's realm, so the parent's policy judged
  them and the worker took them for the parent's. And the parent's read of
  the about:blank's `navigator.serviceWorker` left the document with no
  controller in Chrome 157, though the worker served it. On figma.com that
  refused 70 to 140 requests of its Vimeo players a load (figma's
  connect-src) and their videos never played. The about:blank reads its
  container only once nothing is to load in its frame, and its hooks make
  the requests of the document that follows with that document's own fetch.
  (frame-kept-window suite.)
