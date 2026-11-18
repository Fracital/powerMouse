### Demo and API

- A page of the proxy's own origin loads through STomp like any other site
  (docs/proxyception.md): the demo, its examples and test pages, and the demo
  loaded through itself, whose inner STomp boots, registers its own emulated
  service worker and proxies a third site. The service worker refused such a
  route with a 403 ("the proxy does not proxy its own origin"), and the
  `allowSelfProxy` option that forwarded it instead is gone, and with it the
  request report's and error page's `refused` kind. The inner STomp
  is page code, contained like any site: its requests go out over the
  transport, its cookies and storage are the emulated partition of the
  proxy's origin, and it cannot reach the outer's worker, config or a real
  cookie. What the refusal kept is kept otherwise: a route of a route is
  still unwrapped, never fetched; a page of the proxy's origin names its
  blob: URLs by a UUID of its own, so one of the real origin does not
  resolve for it; and a controller whose host names none mints its access
  API's and stand-in tags' names per host origin (kept like its id), and its
  marker attributes' prefix from them, so an inner STomp's never meet the
  outer's.

### Fixes

- A document's `document.cookie` sees a cookie an emulated service worker
  set through the Cookie Store API at once, as natively, even while the page
  waits on a synchronous request. It kept what it read until the worker's
  message reached it, which a page spinning on the bridge never gets.
- A frame of the proxy's origin in isolation mode, with the site pool on, is
  shown from a slot like another site's; only a route of a route stays on
  the hub.
- Under a codec without a key (`plain`, `base64`), which decodes every
  controller's routes alike, a route of a route is unwrapped only when it
  names the caller's own controller id: an inner STomp's routes and link
  routes go to the inner, where the outer showed their pages itself.
  unroute-unit checks it for plain, base64 and xor.
