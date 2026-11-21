### Demo and API

- The demo dials by default: every tab's frames are its call page
  (`/<scope>/<page>.html` on the server's neutral scope, `?1`, `?2` below
  it) and the top's address a token, with no address of the page asking.
  The classic tabs (each frame navigated to its route under `/stomp/`) are
  shown only where the page cannot dial: a browser without the Navigation
  API (the status line reads `Ready (classic tabs: ...)` and About's
  Dialing row says why; a library that refuses with `NotSupportedError`
  loads the page again with the classic tabs, never a blank tab), a server
  that names a proxy origin (`STOMP_PROXY_ORIGIN`), offline.html (which
  writes into call pages of its own) and a server run with
  `STOMP_DIALING=0`, which the test runner gives the suites of the classic
  path (`DIAL_DEFAULT=1` runs every suite on the default). On `localhost`
  with no proxy origin the page dials on its own origin instead of the
  isolated mode. `?mode=just-call-stomp` still dials, for the suites that
  compare both. The dial scope and call page are derived from the machine
  and the checkout, the same at every start, so a tab open across a
  restart or a deploy keeps a scope the server serves. `dial-default`
  checks the default and the fallback.

### Fixes

- A dialed tab's hard reload (Ctrl+Shift+R, Frame.reload's `bypassCache`)
  fetches the document and what it loads past the caches, as the classic
  tab's does, where it was a plain reload (demo-keys); on a content slot it
  is still a reload. A GET call the host's own worker refuses (its token
  was taken by a worker the browser stopped since, or by the worker a new
  Tor session registered over the last one's) is made again, twice at
  most, with a fresh token and call page, where the tab showed "The call
  was refused or did not load" (demo-tor). The demo's error page in a
  dialed tab retries by asking the host to reload the tab (its own reload
  showed the empty call page), and in Tor mode says Tor is down and loads
  again once it is ready, as in the classic tabs.

### Known limitations

- Dialing keeps the real address out of every tab's frame URL, not out of
  the browser: the address bars' history (`omnibox:visits`, the history
  and most visited lists in localStorage), the token map and each dialed
  tab's history (sessionStorage), the service worker's caches, the call's
  fetch (a route, as DevTools and an extension's webRequest see it) and an
  extension popup's or background page's frame (a route under the scope)
  still hold it. A demo framed by its embedder (SystemYA's `/ui/`) still
  writes the page's sealed route as its own frame's fragment.
