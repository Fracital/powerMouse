### Security

- Dialing (`justCallStomp`, experimental) exists only for a controller made
  with the new `dialing: true`: without it the service worker serves no call
  page and answers no call (a request with the call's header is a request
  like any other), the controller gets no token, and `justCallStomp()`
  throws. Before, every controller's worker served the call page and
  answered calls.
- A dial needs a one-time token: the controller mints 32 random hex digits
  for one route and hands them to its worker over its own channel, and the
  worker answers a call page's fetch only with a token held for exactly that
  route, once (redirects within the scope stay the same call). The call page
  takes the host's message only from its parent window and an origin of a
  controller that opted in, with one port, and builds the request itself;
  every message on the port is checked for its shape at both ends. Firefox,
  which has no `location.ancestorOrigins`, dials too: the parent's window and
  the browser's stamped origin decide there (docs/dialing.md).
- The host no longer reaches into a dialed frame's window: the document tells
  its scroll over the port, restores a step's scroll itself, and asks the host
  for its own frames' tokens, so a call page may be on another origin.

### Demo and API

- The call page's name is an asset, `assets.callPage` (default `k3v9.html`,
  no file in `dist/`), so a host that stamps neutral names renames it. The
  demo's dialing mode serves its scope and call page under names its server
  mints at start (`STOMP_DIAL_DIRECTORY`, `STOMP_DIAL_PAGE`), so a dialed
  frame's URL names no site, route or proxy (`dial-urls` checks every
  frame's `src` and location through navigations, reloads, Back and Forward
  and three depths of frames).
