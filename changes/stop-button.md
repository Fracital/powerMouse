### Demo and API

- The demo's Reload is Chrome 157's Stop while the active tab loads: the
  Tango process-stop picture at Reload's size, "Stop loading this page"
  for its tooltip and its name, and Reload again ("Reload this page") once
  the load is over, swapped at once. A load runs from the start of a
  navigation (the address bar's, Reload's, or a link or script of the
  page's, before its answer comes) to its load event, and a navigation the
  page intercepts loads until its handlers are done. A press stops the
  load where it got to, as does Escape with the focus in the page (unless
  the page prevented the key) or on the toolbar. In the address bar
  Escape first closes the list, then reverts an edit, and only then stops.
  As in Chrome, a load that ends while the pointer is on Stop leaves Stop
  there, disabled, until the pointer leaves or 1.35 s pass, so a press
  already down reloads nothing, and a load that starts within the
  double-click time of a press on Reload waits that long to show Stop.
  A press on Stop takes no focus, as on Chrome's toolbar, and a load that
  ends while the keyboard's focus is on Stop makes it Reload at once, the
  focus kept on it. The same holds in the opt-in dialing mode (just call
  stomp).
- A navigation answered with a 204, a 205 or a download commits nothing,
  as in Chrome: the tab keeps its page, the bar its address, and the load
  is over as the answer comes, where the demo used to wait 30 s. The
  service worker tells the host of such an answer, and the frame fires
  `stayed`. In the dialing mode the host keeps the frame's document for
  one, and saves a download instead of writing it into the frame.
- `frame.stop()` (on `Frame` and `RemoteFrame`) stops a frame as a tab's
  Stop does. A navigation that `go()`, `reload()` or a step has not sent
  yet is never sent. The document stops loading as on its own
  `window.stop()`: what it parsed stays, it is complete, and its requests in
  flight are given up, the worker's read of its markup with them, so the
  origin's connection closes. A navigation the frame was sent that still
  waits for its answer is answered by the service worker with a 204, so
  the browser commits nothing and the frame keeps its page. That covers the
  isolated host and the site pool, where the host set the src of a frame of
  another origin and the document's own stop does not reach the
  navigation. A stop that reaches the worker before the navigation's
  request does holds for 2 s. A called frame's (`justCallStomp`) next
  document is given up the same way: its call is never made, or its
  request is dropped while the worker waits for the answer. A called
  frame's reload is not a hard reload yet. A document stopped this way no longer logs "the markup stream failed". (toolbar
  suite.)
