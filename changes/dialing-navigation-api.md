### Fidelity

- Dialing (`justCallStomp`, the demo's `?mode=just-call-stomp`) gives a
  dialed document the Navigation API over the history its host keeps:
  `navigate` events with `intercept()`, `precommitHandler` and `scroll()`,
  `traverseTo()`, `back()`, `forward()`, `reload()`, `updateCurrentEntry()`,
  `transition`, `activation`, per-entry `dispose`, and `navigatesuccess`,
  `navigateerror` and `currententrychange`, in Chrome's order (an
  intercepted traversal's `popstate` after its handlers settle). A
  document is told only the run of its own origin's entries around its
  own, and `history.length` is the tab's. A step asks the document whose
  entry changes to fire its traversal's `navigate` event first, which a
  step of the page's own (`history.back()`, `navigation.traverseTo()`)
  may cancel and the browser's Back may not, and a document the tab
  navigates away from hears `pageswap`. All of it goes over the call's
  port; the host reads no frame's window. What cannot be had honestly
  fails closed: the events the inject fires are not trusted (`isTrusted`
  false), a cross-origin entry is never listed, a navigation that cannot
  be intercepted throws the browser's SecurityError, and a browser
  without the Navigation API is refused (`justCallStomp` throws
  NotSupportedError) instead of being dialed with its navigations left to
  the frame. A nested frame's history is still its own, not joined to the
  tab's.
- `navigation.navigate(url)` resolves a relative URL against the
  document's base URL, as natively: with a `<base href>`, a bare `#x` is
  another document's fragment (it was resolved against the page's address).

### CI

- The 508 Navigation API web-platform-tests (`test/wpt/navigation-api`,
  upstream cbd1ca1e, the bfcache pages and the one that registers its own
  service worker left out) run as `wpt-navigation-api` in the default mode,
  a gate, and as `wpt-navigation-api-dial` in dialing, run by name; each
  compares the proxied verdicts with the native ones against its
  expected-failure list.
- The WPT runner replaces the default mode's frame when a page kept it (a
  navigate handler that cancels every navigation, the runner's own
  included): every page after such a page used to time out.
