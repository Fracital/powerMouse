### Demo and API

- Just call stomp, an experimental mode a host opts into with
  `justCallStomp(frame, url)` (also `StompController.justCallStomp`; the
  demo's `?mode=just-call-stomp`). The frame never navigates to a site. Each
  document goes into a fresh frame of one constant call page under the
  scope (`assets.callPage`), which the service worker serves and controls; the
  host sends it the route by a message, and the page asks the worker for
  the document with a fetch the worker answers as that frame's navigation
  (the same request upstream, rewrite and shell), then writes the answer
  into itself. Navigations the page starts are cancelled and handed to the
  host, which keeps the tab's session history (in memory and
  sessionStorage) and emulates the location, the referrer, history, the
  Navigation API entries and activation, and the navigation timing type.
  Frames the page makes are called the same way, with call pages numbered
  by depth. In the probes, after five navigations the host's history.length
  stays 2 (natively and in the default mode it reaches 7), and no frame's
  src or real location names a route. Default mode is unchanged.
