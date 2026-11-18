### Fixes

- A controller that shakes hands again with the service worker no longer
  fails what is in flight. A rebind (a worker update the host adopts, the
  controllerchange handler, a build mismatch healed), a revive the
  controller cannot place (a worker too busy right after a restart to say
  hello within a second) and a standby offer taken while the handshake
  that replaced it was on its way all reached the worker as another
  controller at the address, which replaced the one it had: every request
  in flight on the old channel failed at once, a page's fetches with
  `TypeError: Failed to fetch` and a navigation as the host's error page
  (502, "Controller replaced"). Each handshake now names the controller
  instance that made it, and the worker lets the old channel answer what
  is in flight on it before it closes it (at most a minute); the
  controller keeps that channel open until then, the transport it serves
  on it included. A worker the controller left for another (an update)
  is told to do the same. When another controller does take the address
  (the same id given twice), a GET, HEAD or OPTIONS without a body that was
  in flight on the old one is sent again through the new one, as Chrome
  sends one again when its connection closes under it, so the page sees it
  complete. (multi-controller suite.)
