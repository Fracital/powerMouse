### Fixes

- A hidden frame of the proxied page's own origin runs its animation frame
  callbacks while it is not rendered, as it does natively, in isolated mode
  and under the site pool. There the proxied page is of another origin than
  the browser's main frame (the host's page, or the hub's), and Chrome holds
  the callbacks of a `display:none` frame that is cross-origin to the main
  frame, so a page's own hidden frame ran none and measured nothing until it
  was shown, where natively it runs them and measures 0 (Chrome 152 and 156
  hold the frames of a page framed by another origin alike, of another port
  of the same host or of another site, with `Origin-Agent-Cluster` or
  without). While such a frame has no box, the proxied top's animation
  frames run its callbacks, in this frame's time origin; its own request
  still stands, and whichever comes first runs a callback once.
  (hidden-frames suite, now comparing every frame in both modes against the
  page loaded natively.)
- A popup its opener wrote (`window.open('')`, then `document.write`)
  heard the opener's messages in the inject's envelope: the write opened
  the document after the inject had registered its listeners, which ran
  again only once the written script had. The write hook opens it first.
  A popup no longer posts the inject's (and the demo's) messages for the
  host page to itself.
- A link popup of a sandboxed frame (`target=_blank`, or `rel=noopener`)
  kept its opener: the opener was let go after `open()` returned, when the
  window was already of another origin. It is opened with `noopener`.

### Origin isolation

- The site pool, `init.sitePool` (`{ origins: [...] }`), shows every proxied
  site (its registrable domain) from one of a few origins, the pool's slots:
  other ports of the host page's own host, which need no DNS name. Chrome
  gives a secure origin whose documents send `Origin-Agent-Cluster: ?1` a
  process of its own, ports of one host included (docs/process-model.md), so
  a page and a frame of another site in it are two processes as natively.
  With the kit's probe (a page of 127.0.0.1 spins 300 ms while its frame of
  localhost times itself; three loads each), the frame's timers ran 6 to 10
  ms late with a pool of five (natively 6 to 13, with the single-origin
  controller 301 every time) and a message to it and back took 0.5 to 1.8 ms
  (natively 0.4 to 1.8, single origin 0.1 to 0.2), in Chrome 152 and 156
  alike; the two heaps differ, and a window of a site in another slot is
  restricted by the browser itself (site-pool suite, docs/site-pool.md). Off
  by default: the demo's `STOMP_SITE_POOL=5` turns it on (five free ports);
  `sitePool: false`, `STOMP_SITE_POOL=0` or `?nopool` leave it off, and
  nothing changes then.
- `RemoteController` takes `sitePool` too (isolation mode): the controller
  frame is the hub, its agents are its own frames on the slots' origins,
  and `RemoteFrame.go()` navigates the host's frame straight to its site's
  slot; the host takes the reports of the slots' documents, and reads,
  steps and reloads such a frame through its slot's agent, across slots
  by its own trail of them. A page of 127.0.0.1 with a frame of localhost:
  the frame's timers ran 5 to 11 ms late while the page spun 300 ms
  (natively 6 to 12, isolation mode without the pool 300), and both are
  out-of-process frames of their slots (site-pool-isolation suite, Chrome
  152, 156 and 157). The demo's isolated page uses it by default too
  (`?nopool` leaves it out for a visit).
- Isolation mode with the site pool matches the browser where its
  isolated halves did not (docs/site-pool.md, "Isolation mode's halves of
  the suites"): a Critical-CH retry carries the frame's viewport hints
  (client-hints); a tab the host opens for a page's link into a named
  popup carries the page's Sec-Fetch-Site (`cross-site`, not `none`;
  navigation-initiator); `cookies.clear(origin)` from the host forgets the
  device ids each slot's worker kept for that site (permissions); Back
  and Forward across sites step as a tab does, with no Back after
  returning to the first site, a page replaced by another site's taking
  its entry with it, and a frame of the page that went to another site
  stepped first (toolbar-history; `RemoteFrame` keeps runs as `Frame`
  does, src/controller/siteRuns.ts). In both modes a page's
  `history.length` counts the frame's entries in other slots, so a link
  to a site of another slot grows it by one as natively (visited).
- A frame's script that navigates its top or its parent shown from another
  slot (`top.location = url`, `top.location.href = url`,
  `top.location.replace(url)`, `parent.location.href = url`) navigates it
  as natively, where the browser refused it with a SecurityError (the host
  frames the proxied top sandboxed) and printed the slot's routed URLs in
  Chrome's console. The frame decides Chrome's refusals itself (the
  framebusting intervention, the sandbox's flags, a grandchild of a third
  site) from what it knows of the window without reaching it, and asks the
  window to navigate itself, with the frame as the initiator (its Referer
  by its policy, Sec-Fetch-Site), also across a 307 to a third slot. A top
  document's `history.length` counts the frame's entries in other slots
  from its first script after a push, a replace or a reload (it counted
  its own slot's until the hub's count reached it, up to ten fewer than
  natively). top-navigation compares both halves with Chrome 157 under
  the pool: 48 of its 66 cases differed in each, now none.
- A slot's service worker builds no
  blocker engine of its own and asks the host page's worker's over a port
  (src/server/remoteBlocker.ts), so the pool holds one engine and builds
  it once. On a page of five sites (Chrome 152, default lists) the
  browser's processes took 540 MB 45 s after a first visit, against 649
  MB with full slots, 393 MB with the single-origin controller and 322 MB
  natively, and 22% of a core over the first 15 s against 48% (9%, 8%).
- A frame of another slot than its page's (an ad or cookie-sync frame of
  another site) no longer makes a rewriter realm, a copy of the library
  and an instance of the rewriter's module of its own: the slot's agent
  makes one library for every such frame of its slot, before any document
  of the slot exists, in a realm of its own document, as a top makes one
  for its frames (src/controller/slotLibrary.ts). Sixty such frames in
  Chrome 152 took 1.1 MB of heap and 3.1 MB of memory a frame, against
  1.5 MB and 4.5 MB before (1.1 MB and 2.6 MB for a frame of the page's
  own site, 0.4 MB and 1.1 MB natively), and loaded in 1.7 s against 7 s.
- A site's first document from a slot no longer waits for the slot to
  start: while the page is idle the hub starts the agent of the slot the
  next new site would get, and before the page shows any site that of the
  slot that showed one last (`last-site-slot`). A page of one site in
  Chrome 152 loaded it in 0.34 s against 0.79 s (single origin 0.39 s,
  natively 0.17 s) for some 24 MB of an agent it may not use; a page of
  five in 1.3 s against 1.9 s with the same memory. The hub's probe of a
  slot's origin runs beside its agent's frame load, so a slot that never
  answers no longer holds a later navigation up for 5 s (0.15 s). A slot's agent
  compiles the rewriter's module only when its slot needs it (1 to 2 MB
  less a slot), and a slot's worker keeps its share of the memory cache's
  96 MB and of the rewriter instance's memory, since the pool's workers
  share one process.
- A site keeps its slot (the host origin's localStorage, `kept-site-slots`),
  since what its pages store is the slot origin's; a new site gets an empty
  slot, else the one used longest ago, never its embedder's when there is
  another. With more sites than slots some share one, as every site does
  without a pool.
- The host's controller is the hub; for each slot in use it embeds an agent,
  `controllerFrame.html?script=siteFrame.js` on the slot's origin, which
  registers that origin's service worker and runs a controller there with
  the hub's id, options and codec key. The transport is the hub's, and so is
  the cookie jar: every slot's worker asks the host origin's jar over a
  port the hub's transport worker answers (src/server/jarDB.ts), and hears
  of the other slots' changes. Every other store is the slot's own.
- Every origin of the pool is the proxy's own to every thread of it: a
  navigation to a route of a slot's route on the hub's origin lands on the
  single route, on the slot (the hub's worker proxied the slot's URL to
  the slot's own port, which answered its 404), a route that decodes to a
  slot's or the hub's origin is refused like the proxy's own origin, and
  `controller.unroute()` reads a slot's routes, which it answered null
  (double-route suite with the pool on).
- A navigation to a site another slot shows is a 307 to the same route on
  that slot's origin, with what the first worker knew of it handed to the
  second (referrer, policy, navigation hint, redirect chain). A page's
  `history.back()` past its slot's entries is the browser's; the hub's
  `frame.back()`, `forward()` and `reload()` go through the agents.
- A frame of a site another slot shows is judged by its parent and its
  main frame as without a pool: their client hints documents (permissions
  policy, `delegate-ch`, the features each may use), the main frame's
  accepted hints and viewport, and the parent's upgrade-insecure-requests
  go with the navigation to the frame's slot's worker, which keeps them
  (src/server/siteContext.ts). Mixed content is judged where the parent is,
  which hears the console's notices, and a form's route stays in the slot
  of the document that submitted it. The hub's frame delegates to the
  slots what its `allow` gives a frame of the host's origin and every
  feature the host's page has that the attribute does not name, and a
  page's iframe in a slot has the browser read its `allow` delegated to
  any origin (the document is served with the page's policy for its real
  origin), so the camera, geolocation, WebAuthn and the rest reach a
  proxied top and a frame as they do without a pool. The sites' permission
  states are the host origin's one database for every slot, a cleared
  host takes every slot's device ids for its origins, and a host frame's
  size reaches the slot it navigates to (client-hints, permissions,
  permissions-policy, mixed-content, webauthn-related-origins suites).
  A proxied top cannot ask for notifications (Chrome shows a frame of
  another origin no such prompt) nor, before Chrome 156, choose an
  AudioContext's output, as in isolation mode.
- The hub's Back and Forward (`frame.back()`, `forward()`, `canGoBack`,
  `canGoForward`) go where a tab's go and are off where a tab's are, as
  without the pool. The frame's history is composed of runs, a stretch of
  it shown from one slot each, whose states the agent of that slot keeps:
  it hears every report of the frame's documents, of the frames in its page
  and of user activations (it heard none, so Back over a nested frame's
  entry went to the page before, and Chrome's history intervention was not
  told), and a frame in the page that shows another slot's document reports
  its own session history entry. A step to another run is the browser's own
  traversal of the joint history by the steps between, from the frame's
  document, where a `location.replace` left the slot's earlier entries
  reachable (Back on where Chrome's is off). A page that replaces itself
  with another site's (`location.replace`) takes its entry with it, as the
  new document's `navigation.activation` says. (toolbar-history, 27 of 38
  checks passed with the pool, now all, plus sequences of two tabs of two
  sites and of pages replaced by another site's; docs/site-pool.md.)
- A link, a form or `window.open()` that a frame aims at `_top` or
  `_parent` when that window is of another slot (which the browser does not
  let the frame navigate: the host frames the proxied top sandboxed) asks
  that window's inject, in a message with the hub's token, to navigate
  itself; the receiver takes it only from a frame under it. The request
  is a top-level document's as natively, but its initiator (Referer,
  Origin, Sec-Fetch-Site) is the top, as a link's and a form's are with
  the single-origin controller; natively it is the frame.
- A page whose Content-Security-Policy restricts frames (frame-src,
  child-src or default-src, such as the Guardian's `child-src https:`) or
  forms (form-action) keeps every frame and form of another slot it
  allows: the browser's copy of those directives names the pool's slots,
  since the 307 to another slot is another origin to the browser, which
  refused it before (ERR_BLOCKED_BY_CSP, with a violation that named the
  slot's origin). The policies and the frame's real ancestors the first
  slot's worker was told of go on with the navigation, so a redirect the
  page refuses is still refused and a document's frame-ancestors is judged
  against its real ancestors; a frame whose parent is of another slot
  judges its own navigations by the parent's frame-src, which its worker
  hands it. A violation never names a slot (site-pool suite, against
  native Chrome; csp-hosts and csp-navigation now pass with the pool on).
- The pool never relaxes the emulated same-origin policy (site-pool-sop
  suite: every path of window-references and more, natively, with single
  origin, with the run's pool, with a pool of one slot and with a pool of
  two). A frame's `contentWindow` read while its document of another site
  was on the way, and the window `window.open(url, name)` returned for one,
  were the raw window: when that site shares the page's slot (a pool of
  one slot, more sites than slots) the page could read, call and write the
  other site's document. And a window of another slot was raw on every
  path (`frames[i]`, `contentWindow`, `opener`, `event.source`): with a
  pool of two slots, a page that held its frame's window read the document
  of a third site the frame went to next, shown from the page's slot.
  Every path answers the stand-in, as with single origin. A message another slot's page posts with the
  browser's own `postMessage` past the hooks (`w.postMessage` read into a
  variable and called) arrived from the slot's origin: it now never arrives
  (nothing names the site that sent it; with single origin it arrives from
  the sender's origin, natively too). A form submission a frame asks of a
  window of another slot sets only the method, enctype and accept-charset
  attributes on its copy. The frame of a frame of another slot, shown from
  the page's slot, read the page's document by `parent.parent` (the
  browser's own `parent` of the raw window it got); the stand-in it gets
  now answers `parent` with a stand-in, and with one for a parent of
  another slot too, where it answered with itself: a climb by `parent`
  from a frame in the slot of the frame it is in never met `top`, and a
  Yahoo revisit spun its renderers for minutes (site-pool-revisit). A
  window of another slot gets one stand-in for
  every document of an origin in a frame tree (`parent.parent === top`
  and the climb `t = t.parent` meet `top`, frame-walks), a popup the page
  holds as itself comes back as itself, the frame that went to another
  site is its messages' `source` and still its `contentWindow`
  (window-identity), `location.ancestorOrigins` names a top of another
  slot (parent-read), and a cross-origin read's SecurityError names the
  sites, not the slots (error-surfaces). docs/site-pool.md, "Threat
  model".
- A read of a window of another slot costs about what one of another
  site's window costs without a pool: each asked the window questions the
  browser refuses for another origin and caught some four SecurityErrors,
  and `window.parent.top === window.top` took 22 to 30 us where natively
  it takes 0.4 (frame-walk failed). The membrane now tells a window it
  may not read by its prototype, which the browser answers null for
  without an exception, and keeps a frame's top of the proxied world;
  every answer is the one it was. 2 to 3.5 us a read now (docs/site-pool.md,
  "A read of another slot's window").
- The `parent` of a window whose frame was taken out is null, as
  natively: it read as the window itself (or as the proxied top, through
  another window's `parent` getter), and with the site pool it threw
  "Invalid value used as weak map key" (frame-walks).
- A proxied top shown from a slot has focus as a tab's page does: it read
  `document.hasFocus()` false after every navigation (typed, a link, a
  form, `frame.go()`), since Chrome does not tell the process a focused
  frame commits in that it has focus. The hub tells each slot's agent
  which of its frames has focus, and the slot's top document asks for it
  as it starts, before the page runs, only when its frame is that one
  (focus-navigation suite, against Chrome's own).
- A page that is cross-origin isolated natively is isolated in a slot too
  (`crossOriginIsolated`, SharedArrayBuffer, the 5 µs clock) when the host
  page is: the hub's frame delegates `cross-origin-isolated` to the
  slots' origins, and a page's frame of another site, another slot's, is
  delegated `*` with what the page's own `allow` says kept in its route
  (cross-origin-isolation suite: 160 checks failed with the pool).
- Visited links with the pool: a navigation that began at a link route
  takes its visit to the slot it goes to, and a link route it goes on
  through (a site's redirect, a self-link) is the one on the slot of the
  documents whose links name it, so a redirect's target reads visited as
  natively; `controller.unroute()` reads routes of a slot's origin. A
  self-link of a site shown from another slot is not made: the browser
  would key it by the slot of the page clicked on (docs/site-pool.md).
- Demo: `STOMP_SITE_POOL` (a list of ports, or a number of free ones to
  take; 5 when unset, `0` or `off` for none) makes the server answer there
  too, with `Origin-Agent-Cluster: ?1` on what those ports answer, and both
  pages use them as their pool; `?nopool` leaves it out for a visit.
  `STOMP_SITE_POOL_PUBLIC` names the slot ports a front serves, which tells
  the server the port a request came to with `X-Forwarded-Port`.
- Where a slot cannot show sites, the controller shows them from the host
  page's own origin, page by page and with nothing the page can see: a slot
  whose port is closed, that never answers, that a front answers with a
  page of its own, whose service worker does not register or is not
  STomp's, slots that are not secure contexts, `sitePool: false` and no
  origins. Every slot is asked once when the controller starts, and a
  silent one is given four times what the host's origin took (1 to 5 s),
  so the first navigation waits 0.1 to 1.3 s more than without a pool
  where it waited up to 5 s (a silent port), 3 s (a foreign page) and 30 s
  (a worker that is not STomp's). A slot that stops later (its agent's
  document gone, as when its renderer crashes) is left out from then on:
  `frame.go()`, a link from another slot's document (the 307 its worker
  answers), `frame.back()`, `forward()` and `reload()` show its sites from
  the host's origin, where before the frame showed Chrome's error page. A
  site keeps its slot for the next page all the same
  (site-pool-fallback suite, docs/site-pool.md "Fallbacks").
- A navigation to a site's route on the hub's own origin (a page that holds
  a proxy URL, a link of the hub's origin, a fallback's navigation) goes to
  the site's slot when that slot is up, as from a slot: before, the hub's
  worker showed it on the hub's origin, same-origin with the host page and
  away from the slot's storage. It stays on the hub's origin only when the
  slot is left out (site-pool-fallback suite).
- An inline document (a javascript: URL's string, a text/html blob, a
  data: frame) is served by the worker of the origin that registered it,
  the only one that holds its token: its route is never sent to another
  slot. Before, a route whose referrer is of a site the pool shows
  elsewhere went to that site's slot and showed the error page in place of
  the document, and an unknown token's route on the hub's origin was
  answered from the site's slot. An unknown, used or expired token gets
  the error page on the origin its route names (inline-documents suite,
  docs/site-pool.md "Inline documents").
- Two tabs of the host open at once, the newer one closed: the older tab's
  frames keep showing the sites of a slot both used. A slot's worker asked
  the host's cookie jar over the newest tab's port only, and Chrome tells a
  port nothing when its tab closes, so the older tab's next document of
  that slot waited for good on its first cookie read: the frame stayed
  blank and reported nothing (the demo's bookmarks then saw no page in the
  tab, and a reload of the demo brought back the page before it). The
  worker keeps every tab's port and, when a request goes unanswered half a
  second and the tab of the port it asked is gone, asks the newest open
  one. Natively the frame's next page loaded in 8 to 11 ms; through the
  proxy it never came before, and comes now (site-pool-tabs suite,
  demo-bookmarks).
- A sandboxed frame of another slot than its parent did not know its
  sandbox, which the inject emulates from the frame element it cannot
  read: without `allow-scripts` it ran its scripts, with `allow-scripts`
  alone it was of its real origin with its storage, and its popups opened
  as host tabs. The frame's route now carries the sandbox
  (docs/site-pool.md, "A frame's sandbox across slots"; the new
  site-pool-sandbox suite, which fails on all three before).
- Popups under the isolated host (production's default) with the pool: a
  known gap. Every proxied page is a frame of another origin than the
  host's page, and under its COOP `same-origin` Chrome gives such a frame
  null from `window.open('')` and `about:blank` and opens its popups
  without an opener, so a sign-in that opens a blank window and then sends
  it to the provider has no window and no opener to answer. No COOP value
  keeps the host isolated and gives the frames their popups (measured in
  Chrome 152, 156 and 157, docs/site-pool.md, "Popups under the isolated
  host"); a host page isolated by `Document-Isolation-Policy` is the
  follow-up. A page's COOP is emulated meanwhile: a popup whose first
  document's COOP Chrome would not let it keep its opener is served so
  that it is taken out of the opener's group, and a frame of another
  origin than a COOP `same-origin` top opens its popups without an opener
  (docs/same-origin-policy.md, "Popups"). The new `popup-openers` suite
  compares them with Chrome under an isolated host and one that is not.
- Under the isolated host (production's default) a frame of another slot
  than its page's that navigated by a link route (`location.href`, a link;
  to another page of its own site or back to its page's) showed Chrome's
  error page: the service worker answered the link route with a redirect
  outside its controllers' isolation headers, without a
  Cross-Origin-Resource-Policy, and the page's document of another slot,
  with its embedder policy, refused it
  (`corp-not-same-origin-after-defaulted-to-same-origin-by-coep`). A link
  route's answer now carries what any other answer of the worker carries
  there, and the redirects that send a navigation between a slot and the
  hub's origin carry the resource policy always. The site-pool suite, which
  stalled after "a frame that goes to its parent site moves to the parent
  slot" under STOMP_ISOLATION=on, passes there; the new site-pool-coep
  suite (the isolated host and its pool, against Chrome) failed 3 of its 4
  ways before.
- Isolation mode with the pool: a slot's worker knew the host page's
  origin as the proxy's but not the proxy origin itself (the controller
  frame's, `sites.home`), so a route to the proxy origin from a slot's
  document went out over the transport and failed as a network error
  (`fetch` rejected) instead of the 403 refusal, and a frame navigated
  there showed nothing. And the slots' workers were never told
  `allowSelfProxy`, so the demo through itself showed the refusal page.
  Both are as with the pool off now (fetch-credentials, self-proxy).
- A tab of the host opened a second or so after another closed could
  wait 15 s and then show its sites from the host's origin: Chrome
  sometimes never commits an agent's frame on a slot the closed tab had
  one on (the frame's response arrives, its document never starts), and
  the hub gave up on the slot after 15 s. A silent agent frame is
  navigated again at 2, 4, 7 and 11 s, and the one made again 4 s in
  commits at once: five copies of controller-ids at once had 2 or 3 of 5
  returning visits on the host's origin after 17 s before, and 21 of 21
  on the slot after, the slowest in 5.7 s (docs/site-pool.md, "An agent's
  frame that never commits").
- With the pool, WebGL's `powerPreference` reads `low-power` in the
  same-origin page where natively it is `default` (Chrome gives a frame of
  another origin than its top the low-power GPU; isolation mode has the
  same), and a layout shift's last input time, a long animation frame's
  rendering part and an array method made a window's own read as natively
  there (docs/site-pool.md, "Other suites' lists with the pool").
- A page's COOP across slots: the facts a navigation's hint told go on
  with it to the slot it arrives at, whose worker decides as without a
  pool (src/coop.ts), and a window the browser holds COOP `same-origin`
  for stays in its slot for a document that natively keeps its group, so
  no real header severs a pair Chrome keeps (docs/site-pool.md, "COOP
  across slots"). Under a cross-origin isolated host, with the pool or
  without, a popup whose document natively leaves its opener's group is
  served without the host's COOP (and with a Document-Isolation-Policy
  when it is isolated natively), so Chrome severs it as natively; every
  popup kept its opener there before. (coop, popup-openers suites.)

### Known limitations

- The site pool does not carry STomp's passkey provider to its slots
  yet: with the pool on, a site's passkey registrations and sign-ins end
  as the browser's own decline, before any authenticator, as they did
  before the provider (docs/site-pool.md, "Open"; passkeys suite with the
  pool on). Off by default, the pool changes nothing there.
- With the site pool on, a site's service worker cannot show the
  notifications the site was granted: the browser keys a worker's
  permission by its own origin, a slot's, not the host's
  (docs/site-pool.md, "Open"; permission-gates).
