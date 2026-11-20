# The same-origin policy through the proxy

**Measured 2026-11-10 against Chrome 152, both demo modes.**

After the fixes below, every cross-site read the two suites try fails as it
does natively, and every store is partitioned as natively, in both modes;
what still differs is under Left.

Every proxied site shares one real origin: the proxy's. In same-origin mode
that is also the host's; isolated mode (`RemoteController`) moves the host to
an origin of its own, but the proxied sites still share the proxy's. So the
browser enforces nothing between two proxied sites: to Chrome a request from
one to the other is same-origin, an image of one drawn by the other is
same-origin, and their storage is one origin's. STomp has to simulate the
whole same-origin policy, so that two proxied sites (and the host) are as
separated from each other as they would be natively, and a page sees exactly
the cross-origin behaviour Chrome gives it.

This document is the inventory of that policy: each behaviour, what Chrome
does, what the proxy did when it was measured, and the fix. Cross-window
object access (`contentWindow`, `opener`, `parent`, `frames`, named access,
the WindowProxy and Location restrictions) belongs to the window membrane
(`src/inject/dom/modules/*` behind the `membrane` flag, docs/scramjet-parity.md
section 2) and is not repeated here.

## How it is measured

Two fixture origins stand for two sites: the fixture server on `127.0.0.1`
(site A) and the same server on `localhost` (site B), different sites to the
browser. `test/sop-server.mjs` serves one resource, `/sop/r`, whose CORS,
CORP and Timing-Allow-Origin answers the query names, and logs every request
that reached it, so a page can tell a request that was refused before it left
(a failed preflight) from one that was sent.

- `sop-escapes` (test/pages/sop.js): page A reaches site B every way the
  policy governs and records what it could see. The suite loads the page
  natively and through the proxy in both modes and compares each case's
  result, and what reached B's server, with Chrome's.
- `sop-partitions` (test/pages/sop-part.html): site B top-level, then as a
  frame in site A's page, then top-level again; each writes to and reads
  every store (and its dedicated, blob: and shared workers read them), and
  reports the Cookie header its requests carry, its service worker
  registrations and what `navigator.storage.estimate()` counts. Natively the
  frame's stores are keyed by the top-level site too (Chrome's third-party
  storage partitioning, which Playwright turns off; the suite turns it back
  on), and Chrome 152 sends third-party cookies that are not `Partitioned`
  (measured: the frame reads and sends B's top-level cookie).

- `visited` (test/visited-server.mjs): every way of visiting a URL, made in
  Chrome itself and through the proxy in both modes, each with a profile
  that keeps history; then every URL is shown as a link in 17 contexts and
  the pixels of the two are compared ("Visited links" below).

The suites keep a list of the cases known to differ, each with its reason;
a listed case that reads as natively fails the suite, so the list shrinks
with every fix.

## Inventory

"Before" is the proxy on 2026-11-10 (master `5d9b42b`), the same in both
modes for every row. "Leak" marks a row where one site could read another's
data or response; the others are fidelity (a page sees a behaviour Chrome
would not give it).

### 1. Network reads (CORS)

| Behaviour                                                                                                                                       | Chrome                                                                             | Before                                                                         | Fix                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `fetch` to another site without `Access-Control-Allow-Origin`                                                                                   | TypeError, response unread                                                         | **leak**: `basic` response, body and every header readable                     | worker applies the CORS check                                                      |
| ACAO `*`, the page's origin, another origin, `null`                                                                                             | `cors` / TypeError / TypeError / TypeError                                         | `basic` with the body for all four                                             | as above                                                                           |
| Response headers of a `cors` response                                                                                                           | the safelisted ones plus `Access-Control-Expose-Headers` (`*` without credentials) | every header but the Access-Control-* ones, which the worker stripped          | worker filters to the exposed set; Access-Control-* pass through                   |
| `credentials: 'include'` with ACAO `*`, with the origin but no `Allow-Credentials`, with both                                                   | TypeError / TypeError / `cors`                                                     | readable in all three                                                          | credentials mode in the check                                                      |
| Preflight for a non-simple method or header, its `Allow-Methods`/`Allow-Headers` (and `*`), a 500 or a mismatched ACAO on it, `Max-Age` caching | OPTIONS sent first, request sent only if it allows; cached                         | never sent; request always went out (a PUT with any header reached the server) | worker sends and checks the preflight, keeps it for its max-age                    |
| `mode: 'no-cors'` to another site                                                                                                               | `opaque`, status 0, no headers, no body                                            | **leak**: `basic` with the body                                                | worker sends nothing of the response; the page sees an opaque response             |
| `mode: 'same-origin'` to another site                                                                                                           | TypeError before the network                                                       | sent and readable                                                              | worker refuses before the network                                                  |
| A redirect into another site (with and without ACAO), a cross-origin hop without ACAO, a no-cors redirect                                       | TypeError / `cors` / TypeError / `opaque`                                          | readable, `basic`                                                              | each hop checked; a redirect from one other origin to a third sends `Origin: null` |
| `redirect: 'manual'`                                                                                                                            | `opaqueredirect`                                                                   | as natively                                                                    |                                                                                    |
| XMLHttpRequest without ACAO, with credentials and ACAO `*`, a refused preflight                                                                 | `error` event, status 0                                                            | **leak**: `load` with the body                                                 | same worker check                                                                  |
| Synchronous XMLHttpRequest without ACAO                                                                                                         | `send()` throws NetworkError                                                       | **leak**: status 200, body                                                     | the bridge's request carries its document; a network error throws                  |
| `Response.type`                                                                                                                                 | `basic`, `cors`, `opaque`, `opaqueredirect`                                        | `basic` for every route                                                        | inject records the type of each fetch's response                                   |
| A worker's `fetch` (plain, cors, no-cors)                                                                                                       | TypeError / `cors` / `opaque`                                                      | `basic` and readable                                                           | same worker check                                                                  |
| `fetch` from an about:srcdoc document under `no-referrer`                                                                                       | judged as the parent's origin                                                      | readable without CORS                                                          | judged as the document that made it, which vouches for it (see Fix status)         |

### 2. Resource-level policy

| Behaviour                                                                                                                                                                                                                                        | Chrome                                                                     | Before                                              | Fix                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Cross-Origin-Resource-Policy: same-origin` / `same-site` on an image of another site; on a no-cors fetch                                                                                                                                        | load fails / TypeError                                                     | loads, readable (the worker stripped CORP)          | worker checks CORP on no-cors responses before stripping it                                                  |
| `<img crossorigin>` without ACAO; `use-credentials` with ACAO `*`                                                                                                                                                                                | load fails                                                                 | loads                                               | the CORS check covers every `cors` mode load                                                                 |
| `<script crossorigin>` without ACAO; a module script of another site without ACAO                                                                                                                                                                | `error`                                                                    | runs                                                | as above                                                                                                     |
| A font of another site without ACAO                                                                                                                                                                                                              | NetworkError                                                               | loads                                               | as above (fonts are `cors` loads)                                                                            |
| Canvas tainting: `drawImage` of a cross-origin image (also scaled, through a pattern, an ImageBitmap, another tainted canvas, OffscreenCanvas)                                                                                                   | `toDataURL`, `toBlob`, `getImageData`, `convertToBlob` throw SecurityError | **leak**: pixels readable                           | inject taints the canvas                                                                                     |
| WebGL `texImage2D` of a cross-origin image                                                                                                                                                                                                       | SecurityError                                                              | uploads                                             | inject refuses tainted sources                                                                               |
| Canvas tainting by what a load came through (the page's own URL redirected to another site, and back), across documents (a frame's or popup's canvas), a tainted ImageBitmap sent to a worker or cloned, `new VideoFrame()` of a tainting source | tainted / DataCloneError / SecurityError                                   | **leak**: judged by the element's URL, per document | the worker marks the load, the taints are kept for every document that can reach the canvas (see Fix status) |
| `captureStream()` of a tainted canvas or of a media element playing another origin's data; a MediaElementAudioSourceNode of such an element                                                                                                      | SecurityError; silence                                                     | **leak**: the stream and the sound                  | inject (MediaTaint, see Fix status)                                                                          |
| The rules of another origin's stylesheet (`cssRules`, `rules`, `insertRule`, `deleteRule`, `addRule`, `removeRule`)                                                                                                                              | SecurityError unless loaded with CORS                                      | **leak**: rules readable                            | inject refuses by the sheet's real origin                                                                    |
| Opaque response blocking: a classic script of another origin that is HTML, XML or JSON                                                                                                                                                           | `error`                                                                    | `load` (a parse failure)                            | the worker blocks it by type and first bytes                                                                 |
| Muted errors of a cross-origin classic script                                                                                                                                                                                                    | "Script error.", no location                                               | as natively (Unroute's muted check)                 |                                                                                                              |
| `Timing-Allow-Origin` on resource timing                                                                                                                                                                                                         | without it: no timing details, sizes 0, `responseStatus` 0                 | every detail of another site's resources            | inject restricts entries (see Fix status)                                                                    |
| `crossOriginIsolated`; COOP and COEP                                                                                                                                                                                                             | isolated with COOP `same-origin` and a COEP                                | never isolated; COOP, COEP stripped                 | as natively when the host's page is isolated (Cross-origin isolation)                                        |

### 3. Storage and messaging partitions

| Store                                                                                                                                | Chrome                        | Before                                                                                                           | Fix                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| localStorage, sessionStorage                                                                                                         | per origin                    | per proxied origin (worker-side store keyed by origin)                                                           |                                   |
| IndexedDB, Cache Storage, OPFS                                                                                                       | per origin                    | per proxied origin (names suffixed)                                                                              |                                   |
| BroadcastChannel                                                                                                                     | per origin                    | per proxied origin                                                                                               |                                   |
| Cookies, `document.cookie`                                                                                                           | per site/host                 | per real host in the worker's jar                                                                                |                                   |
| Web Locks                                                                                                                            | per origin                    | **leak**: one namespace for every proxied site: a lock B holds is held for A, and `query()` lists B's lock names | names scoped by origin            |
| `navigator.storage.estimate()`                                                                                                       | the origin's usage            | counts every proxied site's usage (a megabyte B wrote shows in A's)                                              | counts the partition's own stores |
| Third-party partitioning: B framed by A shares nothing with B top-level (localStorage, IndexedDB, caches, OPFS, locks, SharedWorker) | partitioned by top-level site | shared                                                                                                           | keyed by top-level site too       |
| CHIPS (`Partitioned` cookies)                                                                                                        | kept per top-level site       | one jar, `Partitioned` ignored                                                                                   | jar keys them by top-level site   |

### 4. Document-level policy

| Behaviour                                                            | Chrome                                                                                               | Before                                                                       | Fix                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `window.origin`, `self.origin`, `location.origin`, `isSecureContext` | the page's                                                                                           | as natively                                                                  |                                                                             |
| `document.domain` setter                                             | host-parsed value (`0.0.1` is `0.0.0.1`, an IP host only to itself, `''` "is an empty domain")       | accepted `0.0.1`; other messages                                             | setter parses the value as a host                                           |
| `postMessage` targetOrigin, `event.origin`                           | per origin                                                                                           | as natively                                                                  |                                                                             |
| `document.referrer`, Referrer-Policy                                 | per policy                                                                                           | as natively (referrer and wpt-referrer-policy suites)                        |                                                                             |
| `navigation.entries()` across origins                                | only the contiguous same-origin entries                                                              | **leak**: B sees A's entry, its full URL included, and `canGoBack`           | entries filtered to the document's origin                                   |
| `:visited`                                                           | partitioned by top-level site and frame origin; never readable by script                             | every proxied link is a proxy URL in one partition                           | link routes (Visited links)                                                 |
| An about:blank a page navigates another origin's frame's child to    | the page's origin (Firefox too; WebKit keeps the parent's): the page reaches it, the parent does not | **leak**: the parent's; the parent reached it and the page got SecurityError | the page's bundle, as its creator, where the browser's `blank` rule says so |

### 5. Workers

| Behaviour                                             | Chrome                           | Before      | Fix            |
| ----------------------------------------------------- | -------------------------------- | ----------- | -------------- |
| A worker's origin, blob: and data: workers' origins   | the page's / the page's / opaque | as natively |                |
| `new Worker` / `SharedWorker` of another site         | SecurityError                    | as natively |                |
| `importScripts` of another site                       | runs (no-cors)                   | as natively |                |
| A module worker's import of another site without ACAO | fails                            | runs        | the CORS check |

## Fix status

Filled in commit by commit; see the CHANGELOG for each.

- **CORS, CORP and request modes** (sections 1, 2 and 5, sop-escapes: the
  46 cases that differed read as natively in both modes). The service worker (`src/server/cors.ts`,
  `genericForward`) judges every non-navigation request by its mode and
  its real initiator: a `cors` request of another origin is preflighted when
  its method or the page's headers are not safelisted (OPTIONS with
  Access-Control-Request-Method and -Headers, no credentials, checked for
  status, origin, credentials, methods and headers, kept for its max-age up
  to Chrome's two hours), its response (redirects included) must pass the
  CORS check or the page gets a network error, and only the exposed headers
  reach it; a `same-origin` request of another origin is refused before the
  network; a `no-cors` response of another origin is refused when its
  Cross-Origin-Resource-Policy says so, and a page's own `no-cors` fetch
  gets nothing of it. A redirect from one other origin to a third sends
  `Origin: null`. The inject's fetch records each response's type (`cors`,
  `opaque`) and an opaque one reads as the browser's (status 0, no headers,
  no body, no URL). The inject's own copies of a page's loads are judged as
  the load they stand for, by a grant the inject announced for each (the
  load gate, below); the page's own requests never carry the proxy's
  headers (fetch, Request and XMLHttpRequest drop them), and one that did
  would be judged as the request it is. A synchronous XMLHttpRequest the policy
  refuses throws NetworkError, as natively. Cost: nothing on a same-origin
  request; a preflight is the round trip Chrome makes too.
  A client whose URL names no origin is judged by the one the worker
  recorded for it: a blob: worker's (its minting document's) and an inline
  document's (a `javascript:` URL's, a blob: or data: document's, recorded
  when the worker serves it), kept in IndexedDB so a service worker restart
  does not turn them into opaque origins (`src/server/blobOrigins.ts`).
  A host rule that sets the request's Origin (WS1's host Origin for a
  configured site) makes the CORS check and the preflight speak for that
  origin.

- **Canvas tainting** (section 2, sop-escapes: the 8 cases read as natively
  in both modes, and three more that must not taint or must: an SVG
  `<image>`, an image in a written about:blank frame, data: and blob:
  images). `CanvasTaintModule` (`src/inject/dom/modules/CanvasTaint.ts`)
  keeps which canvases, contexts, bitmaps and patterns hold another origin's
  data: a 2D or OffscreenCanvas context that draws an image, video, SVG
  image or canvas whose loaded URL is of another real origin and not a
  `crossorigin` load (which the worker's CORS check let through) is
  tainted, and so is a pattern or ImageBitmap made from one; a tainted
  canvas refuses `toDataURL`, `toBlob`, `getImageData` and `convertToBlob`
  with Chrome's SecurityError, and WebGL refuses a tainting source as a
  texture. WebGL's uploads are hooked on the first context of each kind
  (naming the two interfaces costs a frame about 85 KB): a page that takes
  `WebGLRenderingContext.prototype.texImage2D` before any context exists
  names the interface first, which is an accessor on the window until
  then; its first read gets a context of the kind from the native
  `getContext`, hooks its prototype and makes the name the data property
  it natively is (where it natively is among the window's keys, and so it
  reads for `getOwnPropertyDescriptor`), before the page holds the method
  (sop-escapes: the early-taken `texImage2D`, `texSubImage2D` and WebGL 2's
  `texImage2D` refuse another site's image). Cost: a draw is a WeakSet
  lookup on a canvas that is tainted already, else a WeakMap lookup and a
  native getter call; 200,000
  `drawImage` calls of a same-origin image took 280 to 340 ms natively and
  295 to 320 ms proxied (noise).
- **Web Locks** (section 3, sop-escapes: 2 cases). The Partition module
  scopes a lock's name by the proxied origin as it does a BroadcastChannel's:
  `request()` takes the scoped name, `query()` lists only the origin's locks
  by their own names, and a `Lock` reads its own name back.
- **The Navigation API across origins** (section 4, sop-escapes: 1 case).
  The History module narrows the page's view to the run of the frame's
  entries of the document's own origin around the current one, as Chrome
  does: `entries()`, an entry's `index` (-1 outside the run), `canGoBack`,
  `canGoForward`, and `back()` and `forward()`, which fail with Chrome's
  InvalidStateError past the run. `history.length`, `back()`, `forward()`
  and `go()` keep the frame's whole list (natively they cross origins too),
  and so does what the host's Back and Forward buttons are told.
- **`document.domain`** (section 4, sop-escapes: 3 cases). The setter
  parses the value as a host first (`0.0.1` is `0.0.0.1`, `127.0.0.1.` is
  `127.0.0.1`, `a b` shows as `a%20b`), refuses an empty value, an IP host
  other than its own, a value that is not a suffix and a public suffix
  (`'localhost' is a top-level domain.`; one of the list's private section
  too, `github.io` to a page of its customer) with Chrome's messages,
  against the domain the document has now (its host, or what it set). It
  takes effect only in an agent cluster keyed by site, as in Chrome (below);
  in one keyed by origin, the default, it does nothing.
- **Windows of one site, `document.domain` and Origin-Agent-Cluster**
  (agent-cluster suite: fourteen scenarios, Chrome 152 and 156 alike, natively
  against both modes; site-facts). Chrome holds a window by its document's
  origin: a page and a frame of its site on another host (`www.` under the
  site, the site under `www.`) read nothing of each other (SecurityError,
  no `frameElement`, a message's `source` no more than a stand-in). Two
  documents reach each other only when they are same origin-domain: both
  set `document.domain`, to one value and of one scheme (ports aside), or
  neither did and their origins are one. One side setting it is not
  enough, and it makes even two documents of one origin another origin to
  each other (setting it to the host itself counts as setting it). The
  setter takes effect only in an agent cluster keyed by site, which a
  document asks for with `Origin-Agent-Cluster: ?0`; Chrome keys by origin
  by default (`window.originAgentCluster` is true), always for a
  cross-origin isolated document, and an origin's keying in a tab is
  decided by its first document there (a later `?0` of that origin is
  keyed by origin all the same, a later document without the header after
  a `?0` one by site). The membrane compared windows by site (a page and a
  frame of its site on another host read each other whole) and read no
  Origin-Agent-Cluster (`originAgentCluster` was always true and the setter
  never took effect). It now decides by same origin-domain on every read of
  another window, a stand-in it handed out turning into the window once
  both documents set the same domain (the stand-in the page kept from
  before stays one); the service worker hands each document's shell what
  its response asked for (and never passes the header itself to the
  browser, which would key the proxy origin's own agent cluster), and the
  inject keys each origin by its first document in the tab, the tab's top
  keeping the record. Measured natively alone: a popup of the site behaves
  as a frame (the demo opens a popup as a tab of its own).
- **One stand-in per window for every document of an origin** (frame-walks:
  a safe frame's about:blank and srcdoc children, both modes). Natively
  every realm of an agent holds one WindowProxy of a window, so a frame's
  `top` is its parent's `parent` from any document of its origin, as `===`,
  `Object.is` and a WeakMap key. The stand-in for a window of another origin
  is kept by that window's client, one per origin (or domain set) of the
  documents that read it, whatever their sandbox: a sandboxed document made
  its own, so in the about:blank child of Google's sandboxed safe frame
  `parent.parent` was not `top`, and DoubleVerify's climb to `top` never
  ended (nytimes' tab hung at 100% CPU). An opaque document still has its
  own. The stand-in navigates and posts as the document that reached it
  last (its sandbox, its user activation, its place in the tree), not as
  the one that made it, and a window it hands out answers as that document
  too.
- **A document's identity is its own URL, never its base URL.** The inject
  resolved a URL the page writes and decided whose a document was from one
  URL, which followed the document's `<base href>`: a page of one site that
  named another site's page as its base was that site to its stores and to
  the membrane. It read the other site's `localStorage`, IndexedDB and
  cookies, its frames' documents were its own to read, and theirs it
  (base-identity suite, natively against both modes; agent-cluster frames it
  too). A document's `url` is now its own (a routed document's route, what
  the shell of a document the page made named, an about:blank or srcdoc
  document's maker's), and what a URL it writes resolves against is its
  `baseURL`.
- **A frame that is to show another origin gets a fresh browsing
  context.** Chrome keeps a frame's WindowProxy across a cross-site
  navigation (the same object as `frames[i]` and `contentWindow`) and
  checks every access against the document it shows now: a window the page
  held while the frame was of its origin throws on every read but `length`,
  `top`, `parent` and `closed`, and still takes a message, a location set,
  focus and blur. Every proxied site is the proxy's one origin, so the held
  window read the next site's document whole, its globals and storage with
  it (held-windows suite). The inject now takes the frame element out and
  puts it back where it was (a new browsing context) before such a
  document commits; the navigation goes on in the fresh context with its
  request (a POST's body, the referrer it had). Every way a frame's
  document changes origin is gated: the frame's own document cancels the
  navigation in its Navigation API `navigate` event, which every
  navigation a proxied document starts fires (links, forms, location
  writes, `src`, named targets, `window.open(url, name)`); a frame still on
  its initial about:blank, which fires none, is swapped by the page's `src`
  setter, its location setters, `window.open(url, name)` and links and
  forms aimed at it; and the service worker answers a redirect of a
  frame's navigation to another origin with a document that asks the
  frame's parent for the swap (an event on the frame element; the parent
  goes only to a route of the proxy's scope, so a page that sends it gains
  nothing). The window the page held shows its old document and stays the
  frame's window to the page: `contentWindow`, `frames[i]` and
  `event.source` are that object, and a message, a location set, `closed`,
  `length`, focus and blur through it reach the frame, as in Chrome.
  Unlike Chrome, its plain reads (`held.document`, a global) read that old
  document, of the page's own origin, rather than throw, and the browser
  makes no history entry for that navigation: the toolbar's Back and
  Forward (the controller's history of the frame) still step it, the
  page's own `history.back()` does not. A popup held the same way
  stays open: a fresh context for it would cut its opener
  (docs/scramjet-parity.md section 2c).
- **An about:blank a page navigates is of the origin the browser gives
  it** (coi-engines, sop-escapes and sop-partitions suites). When a page P
  navigates the child of a frame X of another origin to about:blank,
  Chrome and Firefox make the new document P's: P reaches it, X reads
  `contentDocument` null and SecurityError for its document, and the
  document's `parent` is closed to it, its base URL P's. WebKit keeps the
  parent's origin: X reaches it, P does not (measured in Chrome 157,
  Firefox 160 and WebKitGTK 2.52.4). Through the proxy the frame's parent
  X injected it as its own: X reached a document of P's origin, P got
  SecurityError, and the document reached X. Now the inject navigates the
  window with P's own Location (P's base URL, P's referrer), and X records
  P as the window's navigator until the window shows another document
  (DocumentClient navigatedBlank, blankCreator). The document then gets
  P's bundle with P as its creator (IFrame injectNavigated), and X's realm
  reads it as one of another origin (Context restrictChild). Which engine
  does which is the service worker's `blank` rule (src/isolation.ts),
  which the controller asks the browser, never its name. Firefox replaces
  the first about:blank document about 200 ms later; that race is
  Firefox's own and is not played out, the state after it is. Under a
  frame of another site the document is in the partition its site has
  with a cross-site ancestor, as Chrome keys it: its `document.cookie`
  reads "" and drops writes, service worker `register` and
  `getRegistrations` reject with InvalidStateError, and its requests, its
  blob: workers' and its blob: documents' carry that partition's
  Partitioned cookies, not P's. P's realm makes those requests (the
  document has no service worker), so they say so: a load grant of `^`
  (src/server/loadGrants.ts), and `cross` on its BLOB_MINTED and inline
  document messages. The worker moves only a first-party client's
  request, and only into its own site's partition under itself, which
  any page reaches natively by navigating a cross-site frame's child. One
  difference stays: the proxy's HTTP cache confirms an entry made for a
  request with other cookies (docs/http-cache.md), so that document's
  fetch of a resource P's top-level page cached reaches the site once
  more.
- **A frame navigates its top and its parent as natively** (top-navigation
  suite: 66 cases, Chrome 152, 156 and 157 alike natively, against both
  modes). A frame's `top.location = url`, `top.location.href = url`,
  `top.location.replace(url)` and the same on `parent` threw a SecurityError
  through the proxy: the inject called the target's location from the
  frame, and the browser refused it, since the host frames the proxied top
  sandboxed and a sandboxed frame navigates no ancestor; the message named
  `replace` for an `href` write, its console line showed routed URLs, and a
  write that did go through made no history entry. Now the inject decides
  as Chrome's `LocalFrame::CanNavigate` does (Context `#refusal`): a
  document navigates a window of its origin-domain or under one, its
  opener, and its top when it has had a user's activation (sticky), or the
  destination is of the top's origin or registrable domain; anything else
  is refused with Chrome's SecurityError ("Failed to set a named property
  'href' on 'Location'", "Failed to execute 'replace' on 'Location'") and
  its console message, the framebusting intervention's, the sandbox's
  (`allow-top-navigation`, `allow-top-navigation-by-user-activation`) and
  "neither same-origin with the target, nor is it the target's parent or
  opener" (a grandchild of a third origin and its parent). A read of the
  top's `location.href` still throws, and `assign` stays out of reach on
  another origin's Location. An allowed navigation is made from the target
  window's realm through its own Location (route, history entry, fresh
  context as for its own navigation), after the frame told the service
  worker it started it (`INITIATOR_ROUTE`, a POST its routed document makes,
  which carries its referrer policy, and which no resource timing entry of
  the page shows, compared with the page's entries natively): the request's
  Referer is the frame's
  URL under the frame's policy (none from an opaque one), Sec-Fetch-Site
  compares the frame's origin, and Sec-Fetch-User is `?1` only when the
  frame had activation and is of the target document's site (measured:
  Chrome sends none for a click in a frame of another site). The same goes
  for a same-origin frame's navigation of its top, whose Referer was the
  top's own URL, and for a link or a form a frame aims by name at a sibling
  frame (the host frames the proxied top sandboxed, so the browser
  navigates no sibling for a frame): a POST form is a copy of it the
  sibling submits once its document is written in, with the entry list
  the frame built, and the sibling's navigate event shows the link or the
  submitter as its `sourceElement` and a user's click as `userInitiated`
  (Sandbox, History `navigatedBy`). Left: Chrome consumes the frame's activation when a frame
  of the top's site navigates the top, and when
  `allow-top-navigation-by-user-activation` lets it, which the inject
  cannot do (`navigator.userActivation.isActive` reads true after); a frame
  that lands in a frame gains no history entry (the fresh context, above);
  an announcement names only its own document as the initiator (a page
  could pre-announce a navigation to a URL another window then makes,
  claiming it as its own, with a Referer of its own URL, which it could
  send by navigating there itself).
- **Where a site ends** (samesite, sop-partitions and site-facts, with
  the names of `test/private-sites.mjs`: `stomp-a`,
  `www.stomp-a` and `stomp-b` under `github.io`, `blogspot.com`,
  `s3.eu-west-1.amazonaws.com` and `cloudfront.net`, and under `co.uk` as
  the control). Chrome 152 and 156 end a site at the public suffix list's
  private section for everything it decides by site, exactly as at `co.uk`:
  Sec-Fetch-Site (`same-site` to the name under a, `cross-site` to b), the
  SameSite cookies of a fetch, a frame's document request and a WebSocket
  handshake (b gets the `SameSite=None` one alone), a frame's storage
  partition and the HTTP cache's key (the name under a shares a's, b has
  its own), and `document.domain` (the suffix "is a top-level domain").
  The service worker's fetches, the jar and the partitions asked with the
  private section already. Three places asked the ICANN section alone and
  took the two customers for one site: the SameSite decision for a
  WebSocket handshake's cookies (b got a's Strict and Lax cookies), the
  site the window membrane compares windows by (a page of a read b's frame,
  and b's frame its parent) and `document.domain` (which took `github.io`).
  All three ask with the private section now. More rows differed for
  every suffix, `co.uk` included, and read as natively now. A context in a
  partition (b's frame under a's page; measured too for a frame of a under
  a frame of b under a's page) has `SameSite=None` cookies alone: its
  `document.cookie` reads no `Lax` or `Strict` cookie and one its script
  writes is not kept (before, the write showed up in that site's own
  top-level page); its Cookie Store API and its service worker's read none
  either, and a write of one and any deletion (a deletion is a `Strict`
  write) reject with Chrome's TypeError ("Cookie was malformed and could
  not be stored, due to problem(s) while parsing."), where they used to be
  stored; and its own WebSocket's handshake carries none, with its
  Partitioned cookies (the inject names the partition to the controller
  in a header of its own, `$stomp$partition`, which never goes out; the
  handshake used to be judged by its Origin alone); so do its fetches,
  which went by their initiator and the nested top in their Referer, so
  that a frame of a under b's frame, a partitioned worker or a Referer
  the policy cut down got a's `Lax` and `Strict` cookies. And a response
  to a request whose site for cookies is another site, or that another
  site started, a top-level navigation aside, sets `SameSite=None`
  cookies alone: a's fetch of b, b's frame's document, the fetch of a
  frame of a under b's frame, and a frame of b that navigates itself to
  a (each used to set all four). The windows of one site, document.domain
  and Origin-Agent-Cluster read as natively too (above).
- **Resource timing** (section 2, sop-escapes: 3 cases, and 3 new ones
  that read as natively). Only the worker sees a response's
  Timing-Allow-Origin: when it names the page (or `*`) on a load of another
  origin, the worker adds a Server-Timing metric of its own (`stomp-tao`) to
  the response, and the ResourceTiming module
  (`src/inject/modules/ResourceTiming.ts`, pages and workers) shows the entry
  of another origin's resource without that mark as Chrome's restricted one:
  every timing between `redirectStart` and `responseStart` and the three
  sizes 0, `nextHopProtocol` and `deliveryType` empty, no Server-Timing
  metrics, in the getters and in `toJSON`. `responseStatus` and
  `contentType` of another origin's load are 0 and empty unless it was a
  fetch or XMLHttpRequest (CORS-checked). The mark never reaches the page.
  `workerStart` is 0 on every entry, as for a page with no service worker
  (it was the time the proxy's worker started, a tell on every entry).
- **Emulated service workers** (sop-escapes' second part, `test/pages/sop-sw.js`:
  12 cases, natively against `?sw`). A request the page's emulated worker
  answers is the worker's: the worker sends no preflight for it and checks
  nothing of its answer against the page's origin; the worker's own
  fetches are judged as the worker's origin's (one preflight, from the
  worker's fetch). Its answer carries its type and URL
  (`x-stomp-response`, never shown to the page): an opaque answer to a
  request that is not no-cors is a network error, one to a no-cors request
  reads as opaque (its bytes go on, so an image shows, and a canvas that
  draws it is tainted through a Server-Timing mark on the load), a `cors`
  answer reads as `cors` with the worker's URL, a body the worker made is
  `basic` whatever the URL. An emulated worker's own no-cors fetch keeps
  its bytes (its realm reads nothing of them: an opaque response's body
  methods give nothing), and the Cache API keeps a `cors` or opaque
  response with its type, in a page and in a worker. A background fetch's
  downloads go as the page's CORS requests (a refused one fails the
  fetch with `fetch-error`, as natively).
- **Third-party storage partitioning and CHIPS** (section 3,
  sop-partitions: the 14 checks per mode that differed read as natively,
  and so do the 10 more per mode that the checks added with this found
  differing: what workers see, the Cookie header and service worker
  registrations). Every store is keyed by a storage key
  (`src/partition.ts`): the proxied origin, and `^<top-level site>` after
  it when the top-level document is of another site (scheme and
  registrable domain by the public suffix list with its private part, no
  port). The Partition, IndexedDB, Storage and Worker
  modules put that key where they put the origin before
  (`name@<origin>^<site>`, the OPFS directory, the worker-side
  localStorage and sessionStorage key, a shared worker's name), and a
  first-party key is the origin alone, exactly what they used before, so
  nothing stored before partitioning is lost (what a frame stored before
  stays its site's first-party data). A document decides its partition from
  the chain of proxied parents (`DocumentClient.partition`, once per
  document); a worker takes its creator's before any of its script runs: a
  routed worker's route kind names it (`js:worker:top:<site>`, kept across a
  redirect of its script), a blob: worker's bootstrap sets it, an emulated
  service worker takes its registration's. Emulated service worker
  registrations are keyed by scope and partition (a first-party one keeps
  the key it had), match and control only the clients of their partition,
  and their events carry it. The jar keeps a `Partitioned` cookie set where
  the top-level site is not the cookie URL's own with that site
  (`partitionKey`, and an id of its own); one set first-party keeps the
  shape and id it always had. A request carries the Partitioned cookies of
  its top-level site, which the worker reads from the navigation's route,
  the client's route (a nested document's, a partitioned worker's), a blob:
  worker's minting document (recorded with its origin) or the client's own
  site: a top-level page's request to another site carries that site's
  cookies of the page's partition, not its first-party ones.
  document.cookie and the Cookie Store API tell the jar their document's.
  Third-party cookies that are not Partitioned are sent as before, as
  Chrome 152 and 156 send them by default. Cost: a frame walks its parents
  once per document; the rest is a longer string.
- **`navigator.storage.estimate()`** (sop-escapes: 1 case;
  sop-partitions: 2 per mode). The StorageEstimate module answers with the
  usage of the context's own storage key: its Cache Storage bodies (a
  cached body is a blob, so its size is no read), its OPFS files, and its
  IndexedDB databases. A database counts what Chrome's takes on disk, as
  measured in Chrome 152 with a profile on disk (`src/inject/idbSize.ts`):
  592 bytes, 352 per object store, and per record about 210 past its key and
  its value's serialized size, a value of more than 64 KiB counted at the
  size snappy compresses it to (a megabyte of zeros: 50,456 bytes natively,
  50,351 here; the storage-estimate suite compares seven shapes, all within
  2%, where the raw sizes missed five by far). 64 records per object store
  are sized and multiplied out by its
  count. An off-the-record profile counts in pages instead, which this does
  not follow. localStorage is not counted, as Chrome does not count it.
  The quota is that usage plus what the browser has left for the proxy
  origin, as natively a quota is the usage plus what is left; only the
  types in use are in `usageDetails`.
- **Partitions under a frame of another site, inline documents, the HTTP
  cache** (sop-partitions: an A-in-B-in-A step, blob: and `javascript:`
  documents and the caches; against the code before, 36 cases per mode
  differ, and all read as natively now, the memory cache's 3 with the
  bullet below). Natively a site framed by a frame of another site under
  its own top-level page (B in A in B) shares nothing with that page: its
  storage key and its cookie partition key have the ancestor chain bit.
  Its partition is now `^<top-level site>` like any third-party context's
  (`partitionOf`), its own site being the top's: a nested route's marker
  says so (`<top origin>/x`, `nestedMark`; read as an origin it is the top
  origin as before), set by a document for the frames it makes when it is
  in a partition itself, and kept across a redirect, which used to drop the
  marker and make a redirected frame a top-level document. Chrome's cookie
  partition key is cross-site for every context in a partition and for a
  top-level page's request to another site (measured: B framed by A reads
  what B set for A's own request): the worker takes the requesting
  context's partition from its route. A document the page makes itself (a
  blob: document, a `javascript:` URL's) is in its creator's partition: the
  worker records it with the document's origin when the creator registers
  it (from the creator's route, never from the message), so its requests
  carry that partition's cookies; its document.cookie reads "" and its
  writes do nothing, as Chrome has it for a document whose URL is not
  http(s), and so does an about:blank such a document makes. The HTTP
  cache (`cache` option) keeps an entry under the request's top-level site
  and the site of the frame or worker that makes it, as Chrome's network
  isolation key (measured: another top-level site, or another frame site
  under the same top, fetches again; B in A in B gets B's top-level
  entry); a request of an opaque or unknown client is not cached.
- **Credentialless frames** (credentialless suite, both modes, against
  native: 204 of 325 checks differed before). Natively a frame with the
  `credentialless` attribute, and every frame under it, is in a partition
  of its own keyed by a nonce of the top-level document: the credentialless
  frames under one top-level document share it, a new top-level document
  starts another, empty one, and it shares nothing with the site's
  first-party stores or its partition under that top-level site (B framed
  credentialless by B is apart from B too). Its requests carry none of the
  site's cookies, what it sets lives in that partition only, its loads are
  never kept in the HTTP cache (measured in Chrome 157: each fetch of a
  resource kept for an hour goes to the network, within one nonce too, and
  a no-cache entry's validator is never sent), the preflight cache keys by
  it, `window.credentialless` reads true and its popups open without an
  opener. The proxy kept the attribute from the browser and did none of
  it: the frame read the site's cookies and its first-party or
  third-party stores, and `iframe.credentialless` read false. Now the top's
  inject draws the nonce when its first credentialless frame is routed,
  the frame's route says it (a `!<nonce>` segment of `nestedMark`, kept by
  the frame's own navigations, the frames it makes and a redirect), and
  the partition is `^<top-level site>!<nonce>`
  (`credentiallessPartition`), which every store, worker and registration
  keys by as for any partition. A document without a route (about:blank,
  srcdoc, blob:) takes its parent's. The jar keeps every cookie set in such
  a partition under it, Partitioned or not, and sends such a context no
  other (`ephemeralKey`); the worker keeps none of its loads in the HTTP
  cache or the rewrite cache. `iframe.credentialless` reads the attribute,
  `window.credentialless` is answered true in those documents only (no
  other frame gets a wrapper), and window.open in them opens without an
  opener (`opensWithoutOpener`). Setting the attribute on a frame in a
  document takes effect at its next navigation, as natively, where it
  used to navigate the frame again under an isolated host.
- **The renderer's memory cache** (sop-partitions: 3 cases per mode).
  Natively each site's documents are in a renderer process of their own,
  whose memory cache hands a fresh image, script, stylesheet, font or text
  track that site loaded before to its next document without asking
  anyone; through the proxy every site's documents are in one process and
  every site's routed URL of a resource is the same, so an image another
  site loaded was answered from memory (another site's page, a third
  site's frame: 1 load reached the site where Chrome makes 2 and 3). The
  worker now hands the browser those responses as `no-cache` without
  validators (and drops the conditional headers the browser adds), so the
  browser asks it again for each document and never revalidates another
  site's copy, and answers from a memory cache of its own
  (`src/server/cache.ts` MemoryCache): per site of the asking document and
  credentials mode, fresh 200s only, 96 MB, least recently used first. A
  miss goes to the HTTP cache (network partition) and the network; with the
  `cache` option on a same-site document's resource never goes to the
  network again while fresh, and with it off the memory cache still
  answers. Cost, measured on YouTube, CNN, Discord and Google (4 runs of
  each build, alternated, medians of the time to the page's main content,
  cold, warm and revisit): within a few hundred ms either way, the noise
  of the runs (see the CHANGELOG).
  What the worker hands on as the origin sent it (an image, a font, a text
  track, a poster: the `binary` routes) is the renderer's to keep again,
  per site (memory-cache-share: a site's second document takes the first
  one's copy without a request, another site's document and an opaque one
  wait for the network, in both modes, as natively). Natively one copy
  serves every document of the site's renderer; with every document handed
  its own, a proxied ad frame held about 4 MB of copies of what natively
  takes nothing past the first frame (an ad frame of three images and a
  web font, 30 frames in one renderer, Chrome 157: 5.0 MB of RSS a frame
  before, 2.9 MB with the mark, natively 2.7 MB). So the route
  of such a load carries a mark of its document's site after its kind
  (`binary;m=<mark>/...`, `src/memoryMark.ts`), and the worker hands the
  load out with the origin's caching headers when the mark is the asking
  document's site's (`siteShared` in `genericForward`): the renderer's
  memory cache, keyed by the URL, keeps one copy per site and hands it to
  that site's next document, never to another's, whose routes carry
  another mark. The mark is no name a page could write: the worker draws
  it from a secret of its own (`src/server/cacheMarks.ts`, kept with the
  codec keys, drawn again on Clear-Site-Data `"cache"` and when the host
  clears the cache) over the build, the site and the emulated service
  worker that controls the document (natively a controlled document's
  memory cache is the controller's), and hands each document its own in
  its shell (`cacheMark`). A page that learned the route's shape, the codec
  and another site's URL still cannot name that site's copy, and a route
  of another site's that a page hands a hook is routed again as its own
  site's. With the site pool each slot origin's worker draws a secret of
  its own, and a slot that holds more than one site keeps them apart by
  the mark as the one renderer does. An opaque origin's document (a frame
  sandboxed without allow-same-origin, a data: document) marks its loads
  as such (`;m=o`),
  and the worker keeps them out of every cache, as natively its renderer
  and its HTTP cache are its own (before, its images and fonts were
  answered from its site's copies). A load the renderer answers this way
  never reaches the worker: its resource timing entry has no worker start,
  which is how the inject tells it (a memory cache's entry, as natively:
  no bytes transferred, delivery "cache"). Scripts and stylesheets are
  rewritten and stay `no-cache`. A route without a mark (one this build's
  worker did not give, an inline document's controlled by an emulated
  worker) is handed out as before. A document with a policy that governs
  these loads (img-src, font-src, media-src or default-src, report-only
  too: `MARK_DIRECTIVES`) marks none of them, and the worker gives such a
  client no mark: natively the renderer judges a load by the policy before
  its memory cache answers, and here the worker judges it by the real URL,
  which a load the renderer answers never reaches (memory-cache-share: a
  document of the site under `img-src` of another host is refused, as
  natively, though the renderer keeps the resource).
- **Output reuse** (`recentOutputs`, master's speed series): the worker
  gives a document the output it just gave it for the same request only
  when everything the policy decides by is the same: the client (its
  origin), mode, credentials, the opaque-origin marker and the page's
  headers that need a preflight (a request that carries the load header is
  never answered from it: a grant is for one request); never for a hop of
  a redirect chain, whose origin may be "null" by then. A refused request
  is never kept. (sop-escapes: a script of another site plain then
  `crossorigin` without CORS, and the other way.)
- **The rewrite cache, and the compiled code Chrome keeps with it**
  (rewrite-cache suite). The worker keeps a script's rewritten output
  (`src/server/rewriteCache.ts`), and answers a script a page loads again
  with the store's own response under its routed URL, which Chrome keeps
  V8's code cache with. Natively that cache is kept per network isolation
  key, since a site that is handed another's compiled code can time which
  of the script's functions the other ran. An output's key includes the
  request's partition: the HTTP cache's (top-level site, site of the frame
  or worker that asks) and whether the request has credentials. A page of
  another site that loads the same script (the same routed URL) is a miss:
  it rewrites the script for itself and its output takes the URL's entry,
  whose compiled code goes with the entry it replaces (the first site's
  output moves under its key and comes back, with no code, without a
  rewrite). A client without a site of its own keeps nothing, as in the
  HTTP cache. Before, the output was every site's that a controller's
  pages loaded: the time a rewrite did not take said that some site had
  loaded that script. The kept response has only the headers a browser
  acts on when it loads a script and the worker's own marks; the origin's
  `Server-Timing`, `Date`, `ETag` and request ids are one request's and no
  later load is given them (a page reads `Server-Timing` from its resource
  timing). It is given only when the response the worker just got from the
  origin (or the HTTP cache) has the same bytes and the same headers of
  that kind, so it never says anything a new response would not.

- **Canvas tainting by the load, across documents, bitmaps and frames**
  (sop-escapes: 9 cases per mode differed). Chrome taints by the origin of
  the response, not of the element's URL: the worker marks a no-cors load
  whose redirect chain went through another origin (`crossed` on the hop it
  remembers, OPAQUE_MARKER in the answer's Server-Timing, which the page
  never sees), wherever the chain ends. The inject reads the mark from an
  observer of its own on resource timing (`ResourceTimingModule.opaqueLoads`,
  natives taken when the bundle loads): its pending records are taken once
  per run of the page's script, so a load judged in its own `load` event is
  known, and clearing the timing buffer, letting it fill or replacing the
  methods that read it changes nothing. An element judged before its load
  ended is asked again. A copy the inject made of such a load for a
  document no worker controls is tainted too (`opaqueCopies`). The taints
  are kept on the outermost window of the proxy's origin a document can
  reach (its parents, then its opener; non-enumerable, under the client's
  secret name), so a canvas a frame or popup tainted is tainted for the
  page that reads it with its own realm's methods. A tainted ImageBitmap is
  refused by every structured clone (`postMessage` to a window, worker,
  port or channel, `structuredClone`, `pushState`/`replaceState`) with
  Chrome's DataCloneError, before the target is looked at, as natively;
  `new VideoFrame()` of a tainting source throws Chrome's SecurityError.
- **A no-cors chain through another origin** (sop-escapes: 1 case per
  mode). A no-cors `fetch` whose chain left the page's origin and came back
  carries the same mark, and the inject's fetch shows it as opaque (status
  0, no headers, no body).
- **Resource timing of fetch and XMLHttpRequest, transfer size and
  protocol** (sop-escapes: 2 cases per mode differed, 3 more compare the
  sizes). The worker's marks ride in Server-Timing (PROXY_METRICS), and the
  inject's fetch and XMLHttpRequest take them out of the headers the page
  reads, so a cors response can carry TAO_MARKER; when the response's own
  Server-Timing is not exposed to the page (no
  Access-Control-Expose-Headers) but its timing is allowed, the worker
  marks it timing only and the inject hides the header. An
  XMLHttpRequest's entry says `xmlhttprequest` (XHR_MARKER). An entry the
  page may read has the `transferSize`, `deliveryType` and
  `nextHopProtocol` Chrome gives each way a load is delivered (messages.ts
  `Delivery`; measured in Chrome 152 and 156): the body and 300 bytes, ""
  and the protocol from the network (see Left for the protocol); 0, "cache"
  and the protocol from the renderer's memory cache; 0, "cache" and no
  protocol from the HTTP cache; 300 after a 304, with "" and the protocol
  when the renderer revalidated what it had, with "cache" and no protocol
  when the HTTP cache did. The worker marks its answers (CACHED_MARKER,
  REVALIDATED_MARKER, MEMORY_MARKER: its MemoryCache stands for the
  renderer's memory, and what it gave a site's documents since it started
  for what that renderer has). A script the rewrite cache answers with its
  kept response cannot carry a mark of the load (the response is the
  store's own, which Chrome keeps the compiled code with: KEPT_MARKER says
  only that), so the worker notes how each such load was delivered and
  tells the window that asked (KEPT_LOAD, src/server/keptLoads.ts); a page
  that reads the entry before the note has come asks the worker over the
  synchronous bridge (sop-escapes: 3 cases per mode; rewrite-cache: after
  the worker stopped, and from the HTTP cache).
- **about:srcdoc documents without a referrer** (sop-escapes: 4 cases per
  mode differed). A srcdoc document's client URL names no origin, and under
  `no-referrer` no Referer does either. When its client starts, the
  nearest routed ancestor's bundle tells the worker a token (SRCDOC_VOUCH,
  from a routed client the worker itself knows the origin of) and the
  srcdoc client claims it with a request of its own (SRCDOC_CLAIM: WebKit
  reports a srcdoc document's message to its worker as its parent's
  client's); the worker binds the claiming client id to the voucher's origin and partition (`srcdocVouches.ts`, kept
  with the blob: origins, so a restarted worker still knows). Either
  message may arrive first; a request of a srcdoc client that is not bound
  yet waits for the pair once (1.5 s at most). A sandboxed srcdoc frame
  without `allow-same-origin` and one under an opaque-origin ancestor are
  not vouched for and stay opaque.
- **Upload listeners and the preflight cache's partition** (sop-escapes: 2
  cases per mode differed; sop-partitions: 6 per mode). The inject counts
  the listeners on each XMLHttpRequest's upload object (`uploadListeners.ts`,
  in pages and workers; `signal` and `removeEventListener` included) and
  says so on an asynchronous request with a body (PREFLIGHT_HEADER, the
  inject's own), which the worker preflights whatever its method and
  headers. The preflight cache is keyed by the top-level site and the
  frame's site too (Chrome's network isolation key).
- **Stylesheet rules** (sop-escapes: 6 cases per mode differed). CSSOM
  refuses `cssRules`, `rules`, `insertRule`, `deleteRule`, `addRule` and
  `removeRule` with Chrome's messages for a sheet whose real URL is another
  origin's and whose `<link>` has no `crossorigin` (a CORS load reached the
  page only past the worker's check), for a sheet of the page's own URL the
  worker marked as having come through another origin, and for the inject's
  copy of either; an imported sheet is judged by its own URL, as measured.
  Inline, constructed and `data:` sheets are the page's.
- **Media: captured streams, Web Audio, loads that are not over**
  (sop-escapes: 10 cases per mode differed). MediaTaint applies
  CanvasTaint's verdicts to what leaves as a stream or as sound.
  `captureStream()` of a tainted canvas or of an element playing another
  origin's data throws Chrome's SecurityError. A stream captured earlier
  ends when its canvas is tainted or its element loads such data: every
  track that carries the source is known (`MediaStreamTrack.clone` and
  `MediaStream.clone` are followed) and stopped. A
  MediaElementAudioSourceNode (from `createMediaElementSource` or the
  constructor) is connected to a gain node the page cannot reach, and
  `connect` and `disconnect` on the source act on that node, so the source
  is heard only while the gate is connected: not for another origin's data.
  While an element loads, what it will play is not known, so from
  `loadstart` until its metadata is in and judged its captured tracks are
  disabled (the page still reads and writes its own `enabled`) and its
  gate is shut; the inject's listeners run even when a page listener stops
  the event (`stopImmediatePropagation` runs them first). A video or sound
  is judged before its load is over, where the resource timing mark is not
  there yet (a stream's never is): the worker records the first routed URL
  of every media chain that crossed, in IndexedDB too
  (`src/server/mediaLoads.ts`), before the answer goes out, and the inject
  asks over the synchronous bridge the first time an element with data is
  judged, once a load. Found on the way: a video or sound over 64 KiB
  behind any redirect did not load at all, because Chrome's media loader
  gives up when a service worker's redirect says `Content-Length: 0`
  (reproduced with a plain worker); redirects now go out without the
  header. Cost: the hooked interfaces (MediaStreamTrack, MediaStream,
  AudioContext, AudioNode, MediaElementAudioSourceNode) are made in every
  frame, about 15 KB of heap each frame (frame-cost: 1065 KB a frame, 1050
  before, ceiling 1120); they cannot be hooked lazily like WebGL's, since
  a page reaches their prototypes through many other names.
- **Opaque response blocking** (sop-escapes: 1 case per mode, ten shapes).
  `src/server/orb.ts` decides as Chrome's ORB v0.2 does for a classic
  script (a no-cors load) of another origin, or one whose chain crossed:
  script types, CSS and SVG go; the never-sniffed types, a 206 or
  `nosniff` on HTML, XML or JSON, and `nosniff` on text/plain are blocked;
  otherwise the first 1024 bytes decide (media by its signature goes; HTML,
  XML and JSON types by Chrome's sniffers for each; text/plain by all
  three; anything else by the JSON sniffer and the prefixes sites put
  before JSON). A blocked script is a network error to the page. Other
  no-cors loads of such a response fail or are opaque either way.
- **The load gate** (sop-escapes `gate/`: 13 cases per mode read another
  site's bytes, 1 is left; sop-escapes `csp/`: 3 of 10 per mode did, under a list's policy;
  load-grants, load-grants-restart and document-kinds suites). Chrome gives an about:blank document no service
  worker, whatever is done to it (measured in plain Chrome 152 and 156,
  table below), so the inject fetches such a document's loads from a
  document a worker does control and hands the element a `blob:` URL: a
  copy. The worker used to judge a request as the load it named in
  `x-stomp-load`, which any realm could write, and the copy's URL was one
  any realm could fetch. Three things changed.
  - _The request is a capability._ The inject's bundle opens a MessagePort
    to the worker when it loads, before any of the page's script
    (`src/inject/dom/loadGrants.ts`); the worker takes it only from a
    client it served a document to, and only the first from each
    (`src/server/loadGrants.ts`). For each copy the inject announces
    `{token, url, load}` on the port and sends the token (22 random
    characters) in `x-stomp-load`. The worker grants it once: to the client
    that announced it, for that URL, within 30 s; a redirect's later hops
    inherit it only with the same token. Anything else in the header (the
    old `image no-cors`, a made-up token, a token used before, one sent
    twice at once) is the page's own request, judged by its real mode. The
    port, the natives it is used with and the tokens are in the module's
    scope. A bundle in a document the worker did not serve (a srcdoc
    document's, an object's or embed's document's) goes through the
    nearest bundle above it that has a channel. Kept in the worker: 2048
    grants at most (512 for one client), 30 s each, 512 channels, 1024
    spent tokens, 4096 clients it served, one challenge for each client.
  - _A worker that restarted_ (Chrome stops an idle one within about 30 s)
    keeps no channel and served none of the documents it finds, so it
    cannot know whose the first channel a client offers is. It takes a
    client's first channel at once only when it answered the navigation
    that made the client's document (`resultingClientId`). Any other client
    is challenged: the worker sends that client alone a nonce (22 random
    characters, in `SW_REVIVE`) and takes the first channel that comes back
    with it, one challenge standing at a time (5 s); a channel offered
    without it, a guess, another client's nonce and a second answer are
    refused. The inject's listener for the nonce is the container's first,
    added before the page ran, so its answer is posted first, and the
    messages of one client reach the worker in order. The inject opens
    the channel again with the ports' getters it took when its bundle
    loaded: before, a page that redefined `MessageChannel.prototype.port2`
    was handed the channel the inject opened again for a restarted worker,
    and read another site's text through it. Then the inject tells its last
    five seconds of announcements again. What is not achievable: a worker
    that restarted can verify nothing it kept, since a secret it handed
    the inject would have to survive in IndexedDB or the Cache, which every
    realm of the proxy origin reads, and the grants it issued before are
    gone with it. The inject's one advantage is that it runs first in its
    document; a realm that ran script in the client before its bundle did
    would hear the nonce first and hold the channel (load-grants,
    load-grants-restart: a page that offers channels until one is taken and
    answers the nonce too gets none, and its announcements read nothing).
  - _STomp's other channels in a page_ are kept from it the same way
    (`src/transport/ports.ts`): a document's transport, the controller's
    wasm modules, the permission verdicts, the emulated service workers'
    calls, a WebSocket's frames and a body's chunks travel on channels made,
    started, listened to and closed with the browser's own MessageChannel
    and MessagePort members, taken when the bundle loads, and only a message
    the browser delivered is heard (a MessageEvent the page dispatches on a
    port it reached is not). Before, a page could replace
    `MessagePort.prototype.close`, reach the port the controller's modules
    were coming on, and play a module of its own on it: under
    `rewriter: 'wasm'` that module rewrote every script of the frames under
    the page, another site's included (rewriter-chosen suite: the frame of
    another site ran the top page's line instead of its own scripts). The
    same through the `onmessage` setter or `addEventListener` gave a site
    the verdict it chose: a site the user had blocked read the location the
    browser holds for the proxy origin (permissions suite).
  - _What a grant hands over is what Chrome would let into the renderer._
    A granted copy of another origin's no-cors load goes through opaque
    response blocking in the worker, whatever the load (it was scripts
    only): HTML, XML and JSON never reach the page's process. A download's
    grant is for the page's own origin.
  - _The copy's URL names nothing._ The worker says which copies the page
    may not read (`x-stomp-copy: opaque`, on a granted answer only). An
    image's (an `<img>`, a srcset, a poster, an SVG image, a CSS `url()`)
    gets a URL made in a worker of the inject's that is then terminated: a
    `blob:` URL dies with the context that made it, while Blink's memory
    cache goes on answering elements and styles that name it, held by an
    image the inject keeps, one for each fragment the value names the URL
    with (the cache keeps a `blob:` URL's fragment in its key, and a
    style's url() carries the page's token after `#`)
    (`src/inject/dom/sealedCopies.ts`; measured:
    `URL.revokeObjectURL` will not do, it purges the cache, and the
    worker's end is not synchronous, so a second URL of the same worker is
    fetched until it fails). Bytes that are no image name nothing at all,
    and the element fires `error` as natively. A script's or stylesheet's
    URL is revoked in the task that sets it on an element in the document
    (a load resolves its `blob:` URL when it starts; measured for classic,
    async, deferred and module scripts and for stylesheets, forty at a
    time), otherwise when the element has loaded; a stylesheet's imports
    when it has loaded. A stylesheet put back into the document afterwards,
    or an image whose cache entry went, fails once and is copied again.
  - _Under a document's policy._ The worker's script is a `blob:` URL, and
    Chrome judges a worker by the policy of the realm that constructs it
    (an about:blank frame runs its creator's bundle, so its creator's).
    Measured in plain Chrome 152 and 156, the same in both: a policy of
    `worker-src 'none'`, of `script-src 'self' 'unsafe-inline'` (no
    `blob:`), of `child-src 'none'` or the proxy's own
    `script-src 'nonce-...'` refuses a worker from a `blob:` URL, in an
    about:blank child as well, and a `SharedWorker` too; a
    `worker-src <URL with its path>` allows that one script and refuses
    `blob:`. A page's own header or meta policy never
    reaches the browser through the proxy (it would refuse the shell), so
    it refuses nothing of the inject's; the policies that do are a list's
    `$csp=` (the blocker carries `worker-src 'none'`, `child-src 'none'`
    and a `script-src` that keeps inline scripts and `eval`) and the
    script policy of a document without allow-scripts. Under a list's,
    the copy's URL was the fallback, a live `blob:` URL of another site's
    image (sop-escapes `csp/`, before: `read 69` in both modes). The
    service worker cannot make a `blob:` URL for a client, and nothing
    else measured could make one that dies while the image stays: a
    removed frame's realm returns `""` from `URL.createObjectURL` and
    throws `InvalidAccessError` from `new Worker`; a frame of the
    document's own, removed in a microtask after the kept image is given
    the URL, makes one (the image loads, the URL fails to fetch, under
    every policy above), but inserting a frame fires its `load` event at
    once to the page's capturing listeners, which reach the new realm and
    can replace its `URL.createObjectURL` before the inject calls it. So
    the blocker names the service worker's route of the worker's script
    (`<directory>sealer`) among the worker sources of every policy it
    carries (`src/blocker/csp.ts`: added to `worker-src`, or a
    `worker-src` of the `child-src`, `script-src` or `default-src`
    sources it falls back to), and a worker the policy refused before it
    answered is made again from that route. The page's own workers are
    judged as before (still refused under `worker-src 'none'`). The
    script policy of a frame without allow-scripts refuses nothing of the
    inject's: its about:blank's copies are made by its parent's bundle.

    | Document (sop-escapes `csp/`)                                                                            | Natively | Through the proxy, before | Through the proxy |
    | -------------------------------------------------------------------------------------------------------- | -------- | ------------------------- | ----------------- |
    | header or meta `worker-src 'none'`                                                                       | refused  | refused                   | refused           |
    | header or meta `script-src 'self' 'unsafe-inline'`                                                       | refused  | refused                   | refused           |
    | frame sandboxed with allow-scripts allow-same-origin                                                     | refused  | refused                   | refused           |
    | about:blank sandboxed with allow-same-origin, written by parent                                          | refused  | refused                   | refused           |
    | an `<object>`'s document                                                                                 | refused  | refused                   | refused           |
    | a list's `$csp=worker-src 'none'`, `child-src 'none'`, `script-src 'self' 'unsafe-inline' 'unsafe-eval'` | refused  | **read**                  | refused           |

    (What the browser's own fetch makes of the URL an about:blank frame's
    image of another site holds; both modes. A frame sandboxed with
    allow-scripts alone has no about:blank its page can write into,
    natively or through the proxy.)

  - The documents (plain Chrome 152 and 156, the same in both; through the
    proxy, document-kinds suite). No service worker: an about:blank frame
    (fresh, `src="about:blank"`, after `document.open` and `write` by its
    parent or itself, navigated back to it, sandboxed with
    allow-same-origin), `window.open('')` and `'about:blank'` popups and
    the frames in them; `clients.claim()` does not claim them and
    `clients.matchAll({ includeUncontrolled: true })` does not list them.
    A srcdoc frame has its parent's worker, so one under an about:blank
    frame or popup has none (its loads were not copied before, and
    failed). blob: and data: documents have none natively; the proxy
    serves them from the worker already (`inline:`), as it does
    `javascript:` documents. An `<object>`'s or `<embed>`'s document has
    none, and its navigation never reaches a worker. A frame navigated to
    a URL the worker serves is controlled and keeps its Window, but the
    about:blank Document the page holds is replaced at commit (what it
    wrote or appended is gone, `contentDocument` is another object), so no
    served document can stand in for a synchronous about:blank. The copies
    stay for about:blank documents, srcdoc documents under them, and object
    and embed documents. A srcdoc document under an about:blank frame or
    popup could be served from the worker instead, as blob: and data:
    documents are (`inline:`), which would give it a worker of its own:
    measured and not built. Fifty images of another site in such a frame
    load in 116 ms (Chrome 156) and 189 ms (152) through the proxy, against
    103 and 140 ms in a srcdoc frame the worker controls and 47 and 91 ms
    natively (medians of 9), so it would save a tenth to a quarter of that
    document's load, but only for that one kind: an about:blank frame's own
    loads (98 and 177 ms) and an object's or embed's stay copies, with the
    same path through the bundle above, and the srcdoc document's readbacks
    (`about:srcdoc`, its base URL, its parent's policy container) would
    need a stand-in of their own.
  - _Module scripts_ (uncontrolled-modules suite, Chrome 157, WebKitGTK
    and Firefox, both modes). Natively a module's static imports in such a
    document load from the network and work in all three engines: inline
    and external modules, relative, path-absolute, absolute and `../`
    imports, an import map's bare specifier, a JSON module, a cycle,
    `import()` from a module and from a classic script, and markup the page
    writes with document.write; a missing import fires `error` on the
    script and runs nothing. Through the proxy each import went to the
    proxy origin's own server, which has no route: every case failed, and
    a module whose import was missing ran. The copies cannot be routes
    either: a module copied to a `blob:` URL resolves a path-absolute
    import against `blob:` and fails in every engine. So the inject loads
    the graph itself, in a deferred part (`src/inject/dom/moduleGraph.ts`)
    loaded at the document's first module: every module is fetched through
    the proxy as the load it is (`script cors`, with the load grant and
    partition of `loadFetch`), its MIME type checked as the browser checks
    a script's, a JSON module's and a CSS module's, and copied to a `blob:`
    URL whose static imports name their own copies, from the leaves up. A
    rewritten module's imports are found by the routes' shape, a bare
    specifier by the `from` or `import` before it, resolved with
    `import.meta.resolve` in the document, under its own import maps. Each
    module is copied once a document, so it is one instance however it is
    imported. An inline module runs a stub that awaits its graph; an
    external one gets its graph's copy as its URL, one written in markup
    after the write (a module does not hold up the parser, and one the
    parser made with neither src nor text has not started); `import()`
    imports the copy. A cycle has no leaf, and a `blob:` URL cannot name a
    module before it is made, so the rewriter's linker
    (`rust/rwjs/src/link.rs`, flag 2048 of the core module) merges a
    cycle's modules into one module, copied once, and each of them is
    copied as a module that exports what it did from that one, as live
    bindings. Each module keeps its own top-level names (one another module
    of the cycle declares, or reads as a global, is renamed, by a scope
    walk of each module, with its function's `name` kept), its own
    `import.meta`, and the order the browser runs a cycle in; a function
    one declares is hoisted across the cycle, and an import of another
    reads that one's binding itself, in its temporal dead zone until it
    runs (measured on a cycle of three modules: `test/pages/um-link-a.js`).
    Left: a `*` import of a module of the cycle reads an object of getters
    (its properties are accessors, and it is not the namespace an
    `import()` of the module answers), and the modules outside the cycle
    run before all of its own. A cycle the linker declines (an import of a
    name the module does not export, a namespace whose names a module
    outside the cycle decides) is closed as before: the import that closes
    it keeps its absolute route, and an import map the inject adds names
    that route's copy, which Chrome and WebKit take at any time and Firefox
    not once a module of the document has loaded. WebKit
    hands an about:blank frame its parent's service worker
    (`navigator.serviceWorker.controller` is set once the frame is made), and
    a module route loaded from it fails: an about:blank document, opened or
    not, that another realm's bundle injects counts as having no worker,
    whatever its controller says.
  - Cost: frame-cost 1070 KB of heap a frame (1064 before, ceiling 1120),
    the bundle 816 KB (809, ceiling 850); an about:blank frame with fifty
    images of another site loads in 48 ms (median of 9; 47 to 62 before,
    44 to 55 natively: no difference outside the runs' noise), one worker
    for the fifty.
- **User activation** (user-activation, against the same pages loaded
  natively, both modes, Chrome 157). Natively an input event activates its
  frame, every ancestor and every frame of its origin
  (`Frame::NotifyUserActivationInFrameTree`): a click in a frame of another
  site activates it, its frames of its own origin and the top, never the
  top's other frames. Every proxied frame is of one real origin, so a
  click activated every frame of the page, and in same-origin mode the
  host's own clicks (address bar, toolbar) activated all of them: a frame
  of another site, or an opaque one, could open a popup, go fullscreen,
  lock the pointer, start a presentation, play sound, vibrate, copy, show
  a picker or the file picker and navigate the top
  (`allow-top-navigation-by-user-activation`) on a click in the top. Now
  each input event in a proxied document walks the page's frames
  (`src/inject/dom/activation.ts`) and notes in each document whether the
  activation is natively its own; the controller notes the host's input
  as foreign to all (`src/controller/hostActivation.ts`). A document a
  foreign activation reached (from an input event elsewhere, or at its
  start: an ad frame that loads its next ad right after a click in the
  top) gets, in its realm and only then, wrappers on
  `navigator.userActivation`, fullscreen, pointer lock,
  `PresentationRequest.start`, the file pickers, `showPicker`, `vibrate`,
  `navigator.share`, `EyeDropper.open`, `execCommand` copy and cut, the
  Clipboard writes, a popup's `window.open`, the device choosers,
  picture-in-picture and media `play()`, each refusing with Chrome's error
  while the browser's activation is explained only by the foreign one;
  the browser's own stays necessary. The rules and the frame walk are a
  deferred statement the proxied top evaluates once for the documents
  under it, so a hooked frame keeps only its wrappers, and the Clipboard
  and the device choosers are hooked when the page reaches them through
  `navigator` (the Permissions module's getters), not made by the hook.
  measure-frame-memory, 60 frames, Chrome 157, a frame of another site
  that loads its next document right after a click in the top: 1,102.6 KB
  with the statement evaluated in each, 1,084.7 KB now, 1,079.5 KB before
  the gates; a frame no activation reached, 1,075.8 KB now, 1,073.6 KB
  before. A document that starts with a sticky activation carried from a
  document of another origin (a link of another site, a URL typed in the
  address bar) drops it. A popup's `window.open` is refused only for an
  activation an input event elsewhere gave: one a document starts with
  keeps the browser's decision (its popup blocker cannot be asked without
  an activation, and with the blocker off, as Playwright runs Chrome,
  every popup opens natively). A tab the host opens for a popup
  (`onOpen`) is opened as the blocker would open the popup: only with the
  document's own transient activation, and one for each, the activation
  then consumed for the tab's documents until the next input event
  (`mayOpenPopup`, popup-activation). Left: a consumed
  activation given back through the proxy within five seconds of one of
  the document's own; an evaluation's activation (no input event) is the
  browser's; the autoplay attribute, a file input's `click()`,
  `AudioContext`, `requestStorageAccess`, `getDisplayMedia` and
  `PaymentRequest.show` are not gated; a native the page took before the
  first foreign activation keeps the browser's answer.
- **Connections** (net-partitions: 4 checks per mode differed). Chrome
  157 keys its socket pool by the top-level site, apart again for a
  context cross-site to it, and apart again for a request without
  credentials (measured with a server that numbers its connections: a page
  of B never gets the connection a page of A opened to C, nor a frame of
  B under A A's own). The transport kept one pool, so every proxied site
  reused every other's connection to a third site: its first request
  there skipped the connect, which a page can time. The worker names each
  request's network partition (its top-level site and whether the context
  is cross-site to it, as the HTTP cache's key) in a field
  (`src/transport/networkPartition.ts`) that our epoxy build reads and
  takes off (deploy/epoxy patches epoxy-tls 0062, epoxy-transport 0054): a
  partition is an epoxy client of its own pool and TLS session caches over
  the one wisp connection, since every connection is a wisp stream
  already, so a user holds one wisp WebSocket as before. Http3Transport
  keys its alt-svc knowledge and QUIC connections (each a wisp UDP stream)
  by the same field. A partition idle for 5 minutes is let go, and at most
  64 are kept. Left: a request without credentials goes on the
  connections of those with (it tells no site anything of another's); a
  transport that does not say it reads the field (libcurl, a host's own)
  keeps one pool, and serveTransport takes the field off for it;
  WebSockets and raw streams have no pool to share. The HTTP cache and the
  renderer's memory cache were partitioned already (net-partitions checks
  the first too).

## Visited links

**Measured 2026-11-11 against Chrome 152 and Chrome 156 (the tables are
identical), both demo modes, with a profile that keeps history (visited
suite).**

### What Chrome does

Script never reads `:visited` (every getter answers as for an unvisited
link), so the suite's links are coloured squares and it reads their pixels
from a screenshot taken over the DevTools protocol (`test/visited-lib.mjs`).
The sites: A and A2 (one site, two origins), B, C, and for self-links S and
W (`v<port>.test` and `www.v<port>.test` on port 80).

- The key is the link's URL with its fragment, the top-level site and the
  frame's origin (`visited_links` in the History database: `link_url`,
  `top_level_url`, `frame_url`). A link clicked on A reads visited at A's
  top level, in a frame of A under A, and in a frame of A under A2 (same
  site); not on A2 itself (another origin), not on B, not in a frame of B
  under A. `U#f` visited says nothing of `U` or `U#g`.
- A visit is recorded under the site and origin of the document that
  started the navigation: a link (HTML, SVG, one a script made or clicked),
  `location.href`, `location.assign`, `location = url`, `window.open`, a
  GET form, `pushState`, `replaceState`, `location.replace`, a fragment
  navigation, a meta refresh. Every URL of a redirect chain is recorded
  with the same key. A typed URL (and what it redirects to) records
  nothing.
- In a frame only a navigation that makes a history entry is recorded
  (`HistoryTabHelper::DidFinishNavigation` returns early unless
  `HasSubframeNavigationEntryCommitted()`): a link, `location.href` after
  load, `pushState`. A frame's first document, `location.replace` and
  `replaceState` in a frame are not.
- Self-links (`VisitedLink::MaybeCreateSelfLink`): a visit whose frame
  origin is the origin of the top-level site's own URL (the registrable
  domain on the scheme's default port) is recorded a second time for the
  visited URL's own site and origin. So a link clicked on `http://v.test`
  reads visited on the visited page's own site too; one clicked on
  `http://www.v.test`, or on any origin with a port of its own, does not.
  The fixtures' usual origins have ports, which is why the suite adds S and
  W. Every hop of a redirect gets its own.
- A document of an opaque origin shows no link visited and records none.

### What the proxy does

Through the proxy every link was a URL of the proxy's origin in a frame of
the proxy's origin under the host's page: one partition for every proxied
site. The browser's own history is still what answers, so the partition is
put where the browser looks, in the link's URL (`src/visited.ts`):

```
before  /stomp/<id>/html/<codec(url)>#fragment
after   /stomp/~/<codec(context + ' ' + url)>#fragment
```

`context` is the frame origin of the document that holds the link, with
`^<top-level site>` after it when that site is not the origin's own:
`https://www.example.com`, or `https://ads.example^https://news.example`.
A link route names no controller and no kind of route, so the same link
reads the same in every tab, at the top and in a frame, and after a restart
(the codec's key is the scope's, kept in the worker's database; the aes
codec, whose routes are salted at random, writes a link route with a salt
taken from its text), exactly when Chrome's key is the same.

No document is ever at a link route. The service worker answers one with a
307 to the document's address, which is the address it had before
(`<id>/html/<codec(url)>`): what a page, the worker (the partition and site
it reads from a client's address), the rewrite cache and the controller's
records see is unchanged. Chrome records every URL of a redirect chain
under the navigation's key, so the link route is in its history, under the
one key every proxied frame has, and a later link with the same route reads
visited. The pieces:

- **Which controller and which kind of frame** the link route leads to: the
  navigation's referrer, which is the address of the document that holds
  the link; what that document told the worker (`NAVIGATION_HINT`, which now
  carries its frame's kind) when the referrer is withheld, or when the
  document is one a page wrote itself (about:srcdoc, about:blank, blob:),
  whose referrer is its parent's address; else the newest live controller,
  at the top level (a link route a host or the user opened by hand).
- **Self-links**: when the context's frame origin is its top-level site's
  own origin, the worker redirects first to the link route of the visited
  URL's own context, then to the document. Decided by the measurement
  above, not by a list of sites.
- **A site's own redirect** of a navigation that began at a link route goes
  on through the link route of the next URL in the same context (the
  worker rewrites the `Location`), so each hop is recorded as natively.
- **Script navigations that make an entry** (`location.href`,
  `location.assign`, `location = url`, `window.open(url, '_self')` after
  the load event) go to the link route. A GET form goes to its form route
  as before, which the worker now redirects through the link route of the
  URL the browser built, in the context its referrer names.
- **`pushState`** makes its entry at the link route (recorded) and puts the
  document's address there in the same call (a replacement, which a frame's
  history does not record). **A fragment navigation** that makes an entry (a
  link to `#part`, `location.hash`) is stopped in its `navigate` event and
  made again as three steps: `pushState` to the link route, `replaceState`
  back to the address the document had, `location.replace` to the fragment
  (the browser's own fragment navigation: scroll, `:target`, one
  `hashchange` with the right URLs, one `popstate`, `history.state` null,
  one entry more, all as natively; compared as JSON in the suite).
- **Redirect counts**: the worker's own redirects are not the site's. It
  counts them along the chain and marks the document (`stomp-hops`, a
  Server-Timing metric the page never sees); the inject takes them off
  `PerformanceNavigationTiming.redirectCount`, `redirectStart` and
  `redirectEnd`, `toJSON`, and the older `performance.navigation` and
  `performance.timing`. A chain whose own redirect crossed origins shows
  none, as natively.
- **Opaque documents** (a sandboxed frame) get a context of their own each
  (`null:<random>`), which no other document's link names.
- **Invisible to pages and sites**: `a.href`, `getAttribute`, `outerHTML`,
  `document.links`, `document.URL`, `document.referrer`, the Navigation
  API's entries and `activation`, navigation timing and error text read as
  natively (the suite compares them as JSON with Chrome's own), and no
  request that reaches a site names a link route (the suite reads the
  fixture's log).

### What a host sees

Nothing new, and no new option. `controller.route(url)` is the document's
address, as before: a navigation the host starts is the user's own (typed),
which Chrome does not record either. `controller.unroute()` reads a link
route back as it reads an address, so a host that takes a link's URL off a
frame gets the real one; a frame the host sends to a link route arrives at
the page (the worker picks the newest live controller of the scope). The
navigate events, `frame.url` and the request log carry real URLs as before.
Visited state is the browser's: it lasts as long as the profile's history
and is cleared with it.

### Decisions

- **The fragment stays outside the encoded part.** Chrome's key includes
  it, and a fragment navigation has to stay one for the browser.
- **The top-level site is in the context only when it differs** from the
  frame origin's own site, so the common link (a top-level page's) is as
  short as before plus the origin.
- **Nothing is kept by the worker** but a few seconds of state between the
  hops of one navigation (`src/server/visitedHops.ts`). The history is the
  browser's own database; STomp stores no visit.
- **A page that listens to the Navigation API** would hear the two steps of
  an entry, so its `pushState` and fragment navigations are made at the
  document's address as before. One that listens for `navigate` may
  intercept a link's navigation, which commits the URL the navigation
  names: its links are given the document's address while a click is
  handled (and the link route again after), and `intercept()` on a
  navigation that names a link route does nothing (the document loads).
  Such a page's router works as before; its visits are not recorded.
- **Cross-window navigations and a frame's `src`** keep the document's
  address: the link route cannot say which kind of frame the target is
  (the referrer is the initiator's, not the target's).

### What is not recorded

Every proxied document is a frame of the host's page, and nothing makes
Chrome record a frame's navigation that makes no history entry. Probed in
plain Chrome 152: `replaceState`, `location.replace` and
`navigation.navigate(url, { history: 'replace' })` in a frame, alone, right
after a `pushState`, and inside a cancelled navigation's `navigate`
handler, never show a link visited; and a history entry cannot be made and
taken back (a traversal is asynchronous and leaves a forward entry). So
these, which Chrome records at the top level, read unvisited through the
proxy (the suite's KNOWN list, each checked to read unvisited everywhere):

| Visit                                          | Why                                                   |
| ---------------------------------------------- | ----------------------------------------------------- |
| `location.replace`, `history.replaceState`     | replace the frame's entry                             |
| `location.href` while the page is parsed       | a navigation before the load event replaces the entry |
| a meta refresh                                 | a client redirect replaces the entry                  |
| `window.open` in a new window, `target=_blank` | the host opens a tab: a new frame's first document    |
| a frame's `src` set by its page                | navigated at the document's address (Decisions)       |
| a link on a page that listens for `navigate`   | followed at the document's address (Decisions)        |
| `pushState` on a page that listens to the API  | made at the document's address (Decisions)            |

All of them under-report. Nothing reads visited through the proxy that
Chrome would show unvisited in the same place: the suite compares 35 kinds
of visit in 17 contexts, cell by cell.

The second row is a replacement through the proxy whatever the page does:
a script navigation before the load event replaces the frame's entry, as
Chrome replaces a top-level document's (the Location module, which made
it so for Back and Forward), and a frame's replacement is not recorded.

### Cost

A link's route is one codec pass, as before, over a longer text (the
context). A page of 5000 links, response to DOMContentLoaded, alternated
runs of the builds before and after (on the build before the wasm
rewriters), medians of 9: 174 and 175 ms before,
183 and 182 ms after (about 2 microseconds a link, inside the spread of
single runs). A link's navigation, start to DOMContentLoaded, with its one
extra redirect inside the worker: 51 and 48 ms before, 49 and 45 ms after
(no measurable difference). `dist/injectDocument.js` grows by 7.7 KB (438
KB to 445, budget 460). A frame pays about 8 KB of heap for the module
(frame-cost, alternated, three runs each on Chrome 152 and 156: 1137 to
1141 KB a frame, 1128 to 1134 before, ceiling 1160). It was 18 KB with the hooks of `performance.navigation` and
`performance.timing` made in every frame (naming the two interfaces and
redefining their getters); they are made only in a document the worker
redirected, which its navigation entry says from the start.

## Cross-origin isolation

### Measured natively

Chrome 152.0.7977.64 and CI's 156.0.8078.79, a local fixture that sends real
headers (`/coi/doc`, `/coi/r` of test/coi-server.mjs); the two versions agree
on every row. "Isolated" is all of: `crossOriginIsolated` true, a
`SharedArrayBuffer` global, a SharedArrayBuffer that clones and posts
(`structuredClone`, `postMessage` to a window, a MessagePort, a
BroadcastChannel, a worker, which then shares its memory),
`performance.measureUserAgentSpecificMemory`, and a 5 microsecond clock
(`performance.now`, `Event.timeStamp`, marks, the timing entries). "Not" is
`crossOriginIsolated` false, no such global (a shared `WebAssembly.Memory`
still hands out the constructor, in either kind of page), DataCloneError
"SharedArrayBuffer transfer requires self.crossOriginIsolated." from each of
those, no `measureUserAgentSpecificMemory`, and a 100 microsecond clock.
History state and IndexedDB refuse a SharedArrayBuffer in either.

| What                                                                                                                                                   | Chrome                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A top-level page**                                                                                                                                   |                                                                                                                                                                                                                                                                                                             |
| No headers; COOP `same-origin` alone; COEP alone                                                                                                       | not                                                                                                                                                                                                                                                                                                         |
| COOP `same-origin` and COEP `require-corp` or `credentialless`                                                                                         | isolated                                                                                                                                                                                                                                                                                                    |
| COEP with COOP `same-origin-allow-popups`, `noopener-allow-popups`, `unsafe-none`; COOP `same-origin` with COEP `unsafe-none`                          | not                                                                                                                                                                                                                                                                                                         |
| Either header in its Report-Only form                                                                                                                  | not                                                                                                                                                                                                                                                                                                         |
| Either value in another case (`SAME-ORIGIN`), quoted, or as a list (`require-corp, require-corp`)                                                      | not                                                                                                                                                                                                                                                                                                         |
| Either value with parameters (`; report-to="x"`, `;foo=bar`)                                                                                           | isolated                                                                                                                                                                                                                                                                                                    |
| Both headers and `Permissions-Policy: cross-origin-isolated=()`                                                                                        | not; `(self)` isolated                                                                                                                                                                                                                                                                                      |
| `Document-Isolation-Policy: isolate-and-require-corp` or `isolate-and-credentialless`, nothing else                                                    | isolated                                                                                                                                                                                                                                                                                                    |
| **A frame**                                                                                                                                            |                                                                                                                                                                                                                                                                                                             |
| Any frame of a page that is not isolated, whatever it sends (but a Document-Isolation-Policy)                                                          | not                                                                                                                                                                                                                                                                                                         |
| A frame without COEP in a document with COEP (isolated or not)                                                                                         | does not load: the element gets `load`, `contentDocument` is null, `contentWindow.location.href` throws SecurityError                                                                                                                                                                                       |
| A frame of another origin with COEP but without CORP `cross-origin` (or `same-site` from its site) on its document, in a document with COEP            | does not load, the same way                                                                                                                                                                                                                                                                                 |
| A redirect on the way to a frame, in a document with COEP                                                                                              | needs no COEP; one of another origin than the document that holds the frame needs the CORP, or the frame does not load. `allow="cross-origin-isolated"` delegates to the origin the element's `src` names, so a frame that a redirect of the page's origin sent to another origin loads and is not isolated |
| Same origin, COEP, in an isolated page                                                                                                                 | isolated                                                                                                                                                                                                                                                                                                    |
| Another origin, COEP and CORP, in an isolated page                                                                                                     | not; isolated with `allow="cross-origin-isolated"` on the element                                                                                                                                                                                                                                           |
| Same origin, COEP, `allow="cross-origin-isolated 'none'"`                                                                                              | not                                                                                                                                                                                                                                                                                                         |
| Same origin, COEP and its own `Permissions-Policy: cross-origin-isolated=()`                                                                           | not, but the clock is 5 microseconds when the frame was navigated as it was inserted (`src` set before it is appended, or markup): that load keeps the Window of the initial about:blank, which the isolated parent made. 100 otherwise                                                                     |
| The same reused Window, when the parent touched it before the load                                                                                     | keeps what the page set on it and its SharedArrayBuffer global, in a document that is not isolated                                                                                                                                                                                                          |
| about:blank and `srcdoc` frames                                                                                                                        | as their parent                                                                                                                                                                                                                                                                                             |
| `<iframe credentialless>`, no headers at all                                                                                                           | loads; isolated when the permission reaches it (same origin, or `allow`), without cookies or stored data                                                                                                                                                                                                    |
| A frame with a Document-Isolation-Policy                                                                                                               | isolated wherever it is, and whatever the permission says (`Permissions-Policy: cross-origin-isolated=()` in it does not undo it); in a document with COEP it still needs COEP (and CORP) to load; a same-origin parent cannot reach its document                                                           |
| `document.featurePolicy.allowsFeature('cross-origin-isolated')`, `getAllowlistForFeature`, `allowedFeatures`                                           | the permission, not the isolation: true with the document's origin in a page without any header; the feature is third in `allowedFeatures()`, the order of `features()`                                                                                                                                     |
| **Workers**                                                                                                                                            |                                                                                                                                                                                                                                                                                                             |
| A dedicated worker of an isolated document, script with COEP; a `blob:` worker; a worker of such a worker                                              | isolated (a `Permissions-Policy` on the script changes nothing)                                                                                                                                                                                                                                             |
| A dedicated worker whose script has no COEP, owner with COEP                                                                                           | an `error` event, no worker                                                                                                                                                                                                                                                                                 |
| A redirect on the way to a dedicated worker's script                                                                                                   | needs no COEP; the script it leads to does                                                                                                                                                                                                                                                                  |
| A dedicated worker of a document that is not isolated                                                                                                  | not                                                                                                                                                                                                                                                                                                         |
| A shared worker, with or without COEP, of any document                                                                                                 | loads; not isolated                                                                                                                                                                                                                                                                                         |
| **COEP's own effects**                                                                                                                                 |                                                                                                                                                                                                                                                                                                             |
| `require-corp`: a no-cors load (image, script, stylesheet, no-cors fetch) of another origin without CORP `cross-origin` (or `same-site` from its site) | fails                                                                                                                                                                                                                                                                                                       |
| `require-corp`: a redirect of another origin on the way to a no-cors load                                                                              | needs the CORP as well, whatever origin it leads to; a redirect of the page's origin needs none                                                                                                                                                                                                             |
| `credentialless`: the same load                                                                                                                        | loads, sent without cookies; a CORS load carries what its credentials mode says                                                                                                                                                                                                                             |
| CORP `same-site` between two ports of `localhost`; of `127.0.0.1`                                                                                      | loads; fails (an IP address is same-site only with its own origin)                                                                                                                                                                                                                                          |
| **Popups**                                                                                                                                             |                                                                                                                                                                                                                                                                                                             |
| Opened by an isolated page or its same-origin frame: a document of its origin with COOP `same-origin` and COEP; about:blank                            | the opener keeps the window                                                                                                                                                                                                                                                                                 |
| The same opener, a document without those headers                                                                                                      | the window reads closed, the popup's `opener` is null                                                                                                                                                                                                                                                       |
| Opened by a frame of another origin than a top-level page with COOP `same-origin`, any document, about:blank included                                  | `window.open` returns null; the popup opens without an opener                                                                                                                                                                                                                                               |
| The same frame under COOP `same-origin-allow-popups` and COEP                                                                                          | the opener keeps the window; the page is not isolated                                                                                                                                                                                                                                                       |

### Through the proxy

Every proxied document is a frame (or a popup) of the host's page, and
Chrome decides isolation by the top-level page: a frame can be isolated only
when the host's own page is. So the host opts in, with the two headers that
isolate any page (COOP `same-origin` and a COEP) on its own page, and
nothing else: there is no library option. The controller reads
`crossOriginIsolated` of its own context when it starts and tells the
service worker and every document (`config.isolated`, internal).

**The host is not isolated.** Nothing is done: no proxied page is isolated,
whatever it sends, and each reads what a page without the headers reads
natively (the suite's last part runs a demo server without the headers).

**The host is isolated.** The service worker serves every proxied document
so that it loads there and is isolated exactly when Chrome would isolate it
natively (`src/isolation.ts`, `src/server/rewrites.ts`):

- Every document and worker script gets COEP `require-corp` and CORP
  `cross-origin` (a frame of an isolated page loads only with the first
  and, from another origin than the host's, the second), and a top-level
  one (a popup) COOP `same-origin`, so that it stays in the host's browsing
  context group. In
  the isolated mode the controller's frames carry
  `allow="cross-origin-isolated <proxy origin>"`, and a redirect the worker
  answers a navigation with carries the CORP too (Chrome asks it of every
  redirect on the way to a frame of another origin's page: without it no
  page that redirects would load). The page's own COOP, COEP
  and Document-Isolation-Policy never reach the browser, as before.
- The worker decides from the response's real headers what the document is
  natively. A page (the document in the host's frame, or a popup) is
  isolated when it sent COOP `same-origin` and a COEP and its
  Permissions-Policy does not deny `cross-origin-isolated` to itself, or
  when it sent a Document-Isolation-Policy. A nested frame is judged against
  its embedder, whose facts ride on the frame's route (the nested mark of
  `src/partition.ts`: whether the embedder is in an isolated group, has an
  embedder policy, whom the element's `allow` delegates the permission to,
  whether the element is `credentialless`): isolated when the group is, the
  permission reaches it and it sent a COEP (or is credentialless), or by its
  own Document-Isolation-Policy.
- A document that is not isolated natively is served with
  `Permissions-Policy: cross-origin-isolated=()`. Under it Chrome itself
  gives the document everything a page without isolation has
  (`crossOriginIsolated` false, no SharedArrayBuffer global, the
  DataCloneErrors, no `measureUserAgentSpecificMemory`, the 100 microsecond
  clock, workers that are not isolated), so no clock is clamped and no clone
  intercepted by a hook. That is why this was chosen over hiding the
  isolation in the inject, which would have had to reach every clock and
  every clone in every realm.
- Two things that header leaves, both from the Window a frame keeps from
  its initial about:blank when it is navigated as it is inserted (measured
  above: the clock stays 5 microseconds and a touched context keeps its
  SharedArrayBuffer). The inject deletes the SharedArrayBuffer global of a
  document that is not isolated (`Isolation.ts`). And the first navigation
  of a frame the permission does not reach, in an isolated group, is
  answered with a document that replaces itself with the same URL
  (`location.replace`, the fragment kept; measured: one `load` event, the
  same history length), so the page's document gets a Window of its own and
  the 100 microsecond clock; the request that comes back carries the
  referrer and policy of the first. For the same reason `Frame.go` of an
  isolated host waits until its element is in the document before it sets
  `src`: a mutation of the document says so, and a 100 ms timer looks for
  an insertion into a shadow tree. The wait holds the element only through
  a WeakRef and ends when the element is collected, or after 10 seconds,
  when `src` is set as asked (the frame then keeps the reused Window). A
  frame the permission does reach keeps the reused Window, as
  natively (so does the 5 microsecond clock of a same-origin frame whose
  own Permissions-Policy denies it).
- A frame Chrome would not load is not loaded: the worker answers a network
  error for a document without COEP (or, from another origin, without CORP)
  whose embedder has one, and for a redirect of another origin without CORP
  on the way to it, and the element then reads as natively
  (`contentDocument` null, `contentWindow.location.href` a SecurityError of
  the page's origin). A dedicated worker's script without COEP under an
  owner with COEP is refused the same way. Shared workers load and are
  never isolated, which is Chrome's own rule for the real worker.
- COEP's own effects are the worker's, by each document's and worker's real
  policy (`src/server/embedderPolicies.ts`), since to the browser every load
  is the proxy's own: under `require-corp` a no-cors response of another
  origin, a redirect included, without a CORP that lets it be had is a
  network error; under
  `credentialless` such a request goes out without cookies. Only under an
  isolated host, or for a page the proxy isolates with its own
  Document-Isolation-Policy (below): under any other a page's COEP does
  nothing, as before.
- `document.featurePolicy` answers for `cross-origin-isolated` with the
  page's permission and origin (`allowsFeature`, `getAllowlistForFeature`,
  `allowedFeatures` in the native order); the real policy would show the
  denial the worker added.

**Popups.** Measured natively (Chrome 152.0.7977.64, 156.0.8078.79 and
157.0.8103.50 agree on every row; the kit is in the sp-popup notes):

- Under a top-level page with COOP `same-origin` (with or without a COEP),
  a frame of another origin than the top gets null from `window.open`,
  about:blank included, and its link popups have no opener.
- A popup leaves its opener (`closed` true at once, no message arrives)
  when its first document's COOP does not match its initial about:blank's,
  which is its creator's top-level document's when the creator is of that
  document's origin and `unsafe-none` otherwise: `same-origin` against
  anything but the same value and origin, `same-origin-allow-popups` only
  against `same-origin`, `noopener-allow-popups` against itself of the same
  origin. An about:blank popup never leaves.
- A page with `Document-Isolation-Policy` (`isolate-and-credentialless` or
  `isolate-and-require-corp`) is cross-origin isolated by itself: its
  frames of another origin load without COEP or CORP and keep their
  popups, and its dedicated workers are isolated without a COEP on their
  script. Documents of one origin that differ in being isolated by it do
  not reach each other (a SecurityError both ways); two that are, whatever
  the value, do. An about:blank frame with
  `allow="cross-origin-isolated 'none'"` reads `crossOriginIsolated` true
  under such a page and false under COOP and COEP.

With the site pool every proxied page is a frame of another origin than
the host's page (its slot's), so under the isolated host (COOP
`same-origin`) a proxied page gets null from `window.open('')` and
`window.open('about:blank')`, and its popups have no opener: the
open-a-blank-window-then-send-it-to-the-provider pattern of sign-in
flows finds no window and no opener to answer. No COOP value both keeps
the host isolated and gives such a frame its popups (docs/site-pool.md,
"Popups under the isolated host"); a host page isolated by a
Document-Isolation-Policy does, in Chrome 137 and later, which is a
follow-up. The host that is not isolated, and the isolated host without
the pool, have none of this.

A page's COOP is emulated as without the pool (`src/coop.ts`): the worker
of the slot a top-level navigation arrives at decides whether it leaves
its browsing context group, from the facts its hint told the slot it left
(carried across with the navigation), and gives the browser a real policy
that makes it so. The browser keeps a group under COOP `same-origin` only
for a document of the same real origin, and every slot is an origin of
its own, so a window it holds that policy for never leaves its slot for a
document that keeps the group natively (one that sends none): the
navigation is served from the window's slot, as a site sharing it is.
A
frame of another origin than a top-level page that sent COOP `same-origin`
opens its popups without an opener, as natively: the frame's route says so
(the nested mark's `o`). With the pool a frame's route also carries its
sandbox (`~` and its tokens), which a frame of another slot cannot read
from its element: without it such a frame ran its scripts with no
`allow-scripts` and opened its popups as host tabs.

`popup-openers` (test/pages/popup-openers.js) compares with Chrome a page
and a COOP `same-origin` page whose frames of another site open popups
every way that keeps a window in the demo (written and navigated
`window.open()`, and `window.open(url)` and links from a sandboxed frame;
the demo takes every other one as a tab of its own): the window, its
opener, messages both ways with their origin and source, `closed` and
`close()`, a popup to a COOP `same-origin` page, links with and without
`rel=noopener`, and a frame sandboxed without `allow-scripts`. It runs
under a demo server whose page is isolated and one whose page is not.

Left:

- Under the isolated host with the pool, a proxied page's popups (above).
- The COOP check is made on the document a redirect chain ends at, not on
  each hop.
- A popup opened on a name (`window.open(url, name)`, a link's named
  target) may be a window that is already open, which the worker cannot
  be told of: its COOP is not emulated. Nor is a link's popup in a host
  that does not take links as tabs of its own (the demo does).
- Without the pool the isolated host is one COOP `same-origin` group: a
  popup of a sandboxed frame (sandboxed too) keeps no opener there, and a
  link popup of one does not load.

`cross-origin-isolation` (test/pages/coi.js, test/coi-server.mjs) loads one
battery in documents with each set of headers of the table (12 kinds of
page, one of them reached through redirects), natively and through the
proxy in both modes, and compares every case: the page itself (20 cases),
its workers (12), its frames (31: same origin and another, with and without
COEP and CORP, through redirects, `allow` and its denial, credentialless,
about:blank, `srcdoc`, a Document-Isolation-Policy, frames navigated before
and after insertion and again) and what its embedder policy does to its
loads (18), and it calls `Frame.go` before the frame's element is in the
document (it is then put into a shadow tree; it is never put there, and the
wait ends at its limit; it is dropped, and the wait ends when it is
collected). 1234 checks in all, two cases
on its known list (the Document-Isolation-Policy frame, below). sop-escapes'
case of a page that sends both headers is off its known list; both suites
run a demo server whose pages send the headers.

What a page sees, by its own headers:

| The page                                                                                                   | Chrome     | STomp, isolated host | STomp, host not isolated   |
| ---------------------------------------------------------------------------------------------------------- | ---------- | -------------------- | -------------------------- |
| COOP `same-origin` and COEP (either value, parameters or not)                                              | isolated   | isolated             | isolated (Chrome 137+)     |
| The same and `Permissions-Policy: cross-origin-isolated=()`                                                | not        | not                  | not                        |
| No headers, one of the two, another COOP value, a Report-Only form, a malformed value                      | not        | not                  | not                        |
| A Document-Isolation-Policy                                                                                | isolated   | isolated             | isolated (Chrome 137+)     |
| Its dedicated workers (script with COEP, `blob:`, nested)                                                  | as it is   | as it is             | as it is (Chrome 137+)     |
| Its dedicated worker whose script has no COEP, when it has one                                             | `error`    | `error`              | `error` (Chrome 137+)      |
| Its shared workers                                                                                         | not        | not                  | not                        |
| Its frame without COEP (or, from another origin, CORP), when it has COEP                                   | no load    | no load              | no load (Chrome 137+)      |
| Its same-origin frame with COEP; another origin's with COEP, CORP and `allow`; about:blank, `srcdoc`       | as it is   | as it is             | as it is (Chrome 137+)     |
| Its frame the permission does not reach (another origin without `allow`, `allow` `'none'`, its own header) | not        | not                  | not, but the clock (below) |
| Its credentialless frame                                                                                   | as above   | as above             | as above (Chrome 137+)     |
| A frame with a Document-Isolation-Policy in a page that is not isolated                                    | isolated   | not                  | not                        |
| `require-corp`: its no-cors load of another origin without CORP                                            | fails      | fails                | fails (Chrome 137+)        |
| `credentialless`: the same load                                                                            | no cookies | no cookies           | no cookies (Chrome 137+)   |

### What a host does

Its own page (the one that holds the controller) sends

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(under it everything the host's own page loads from another origin must
send a CORP; `credentialless` isolates as well in Chrome and Firefox, but
not in WebKit, below). The files of `dist/` and the
transport send the same embedder policy: the controller starts its
transport and rewrite workers from there, and a dedicated worker of an
isolated page starts only when its script has one (the table above;
measured with a host that sends the two headers on its page alone: both
scripts are refused, the proxy runs without the workers, and a page that
isolates itself is isolated). When the proxy is on another origin
(`RemoteController`), those files also send
`Cross-Origin-Resource-Policy: cross-origin`, or the controller's frame does
not load in the isolated page and nothing runs (measured the same way). The demo server sends all three on every
response; `STOMP_ISOLATION=off` leaves them out. A host that sends nothing
is as before.

What isolation costs a host, measured:

- **Popups, when the proxy is on another origin.** Chrome gives a frame of
  another origin than its top-level page no window for what it opens once
  that page sends COOP `same-origin`: `window.open` returns null and the
  popup opens without an opener (the table's last rows). A host that takes
  popups itself (`onOpen`, as the demo's page does) loses nothing, since
  `window.open` returns null there already; a host that leaves them to the
  browser loses the opener and the returned window, for every page. With the
  proxy on the host's own origin popups work as before. This is why the
  suites, which open real popups from the isolated mode's frames, run a demo
  server without the headers (test/run.mjs) except these two, and why
  sop-escapes lists its popup case in the isolated mode.
- The host's own page is isolated too, with what that means for it: its
  no-cors loads of other origins go without cookies (credentialless) or
  need a CORP (require-corp), and a window it opens on another origin, or on
  a page without the headers, has no opener.

### A host that is not isolated (Chrome 137 and later)

A host whose page cannot be isolated (its ads, its sign-in popups) still
gets the proxied pages that are isolated natively isolated. Measured
natively in Chrome 157: a frame of a page without the headers that sends
`Document-Isolation-Policy` is isolated by it alone (`crossOriginIsolated`,
SharedArrayBuffer for it and its dedicated workers, the 5 microsecond
clock), in an agent cluster of its own on a thread of its own (the host's
timers ran on while such a frame was busy for 1.5 s). Documents of one
origin that the policy isolates reach each other whatever their values
(siblings in the host's page included); a document of that origin that it
does not isolate (the host's own page) reaches them only as one of another
origin: `postMessage`, `location`, `frames` and indexed access, `length`,
nothing else. Neither a Permissions-Policy header that denies
`cross-origin-isolated` nor an element's
`allow="cross-origin-isolated 'none'"` takes the isolation from such a
document.

So, where the controller's probe says the browser has the policy
(`IsolationEngine.dip`), the service worker serves a top-level page that
is isolated natively (the table's first rows) with a
`Document-Isolation-Policy` (`src/isolation.ts servedIsolationPolicy`: the
page's own when it sent one, else the value its COEP names), and judges
it as under an isolated host: its embedder policy refuses the frames,
workers and loads it refuses natively. Every document in its frames is
served with the policy too (their route's nested mark says so, `d`), and
so are the inline documents its documents make (about:blank and
`javascript:` copies, `data:` and `blob:` documents: their creator's
client is remembered), since a frame of the proxy's origin outside the
cluster would be out of its parent's reach. A page that is not isolated
natively is served as before. Where the probe says the browser has no
such policy (Firefox, WebKit, older Chromes), and under the site pool,
nothing changes, and the navigate event says `isolation: 'wanted'` for a
page that is isolated natively, which a host may offer a window of its
own.

What the policy took from the controller, which reached its frames'
documents synchronously, and how each is had now:

- **The frame's address, title, history and buttons** (`Frame.url`,
  `canGoBack`, `canGoForward`; RemoteController's `frameInfo`), **Back,
  Forward and Reload**, **the user activations** the history marks and
  **the host's input** (`src/controller/hostActivation.ts`): a hidden
  document of the proxy's origin in the cluster, the agent
  (`src/controller/apart.ts`), answers them over a MessagePort. The
  controller starts it the first time a frame shows a document out of its
  reach once the service worker said it served one with the policy, at a
  route of the service worker's that answers only a token the controller
  gave it over its own channel, once; it runs the controller frame's
  script (`dist/controllerFrame.js`), served with the policy, and finds
  the frames through the windows of the host's page. A frame shows such a
  document when its window throws on `document`; until a document was
  served with the policy, such a frame shows the host's initial
  about:blank (each new tab of a RemoteController), an error page or
  another origin, and no agent is started for it.
- **The host's geometry** (`HOST_GEOMETRY`) and **the compiled core
  module**, which a proxied top reads synchronously from the controller's
  window: the agent keeps both on its own window (the module compiled
  there from the bytes the controller hands it: a Module does not cross
  agent clusters), which the documents of the cluster reach.
- **The service worker's kick** (`SW_KICK`), which a document on the
  host's thread needs when the host's page is busy: not needed, the
  cluster runs on its own thread.
- Unchanged, since they are messages or storage: the navigate, client and
  frame-moved reports, BroadcastChannel, the service worker's channels and
  the synchronous requests to it, storage (one storage key), cookies (the
  worker's jar).

Left:

- A frame of such a page that is not isolated natively (the permission
  does not reach it, or it gives it up) is in the cluster all the same,
  or its parent could not reach it: its inject hides `crossOriginIsolated`
  and SharedArrayBuffer (the `n` of its facts), but the clock stays 5
  microseconds and its dedicated workers are isolated (twelve rows of
  cross-origin-isolation are on its known list for it).
- A frame with a Document-Isolation-Policy in a page that is not isolated
  is not isolated, as under an isolated host.
- The first top of the cluster may compile the core module itself (the
  agent is handed the module when it starts, which may be after the top
  asked).

### WebKit and Firefox

Measured natively in WebKitGTK 2.52.4 (MiniBrowser over WebKitWebDriver;
Safari and every browser on iOS are WebKit) and Firefox 157 (headless,
WebDriver BiDi), beside Chrome 157, in the coi-engines suite and in pages
of their own (a page with COOP `same-origin` and COEP `require-corp`, its
frames and workers):

| What                                                               | Chrome       | Firefox      | WebKit       |
| ------------------------------------------------------------------ | ------------ | ------------ | ------------ |
| A page with COOP and COEP `credentialless`                         | isolated     | isolated     | not          |
| Its frame or dedicated worker with COEP `credentialless`           | loads        | loads        | no load      |
| Its frame that gives up the permission (`allow`, its own header)   | not isolated | isolated     | isolated     |
| Its frame of another origin (COEP, CORP, no `allow`)               | not isolated | isolated     | isolated     |
| A page with a Document-Isolation-Policy alone                      | isolated     | not          | not          |
| A frame with a Document-Isolation-Policy                           | apart        | as any frame | as any frame |
| A `credentialless` frame without an embedder policy                | loads        | no load      | no load      |
| A dedicated worker (or a blob: one) of a page that is not isolated | not isolated | not isolated | not isolated |
| An about:blank a page navigates another origin's frame's child to  | the page's   | the page's   | the parent's |

Firefox and WebKit have no `cross-origin-isolated` permission: every frame
and worker of an isolated page is isolated. WebKit has no `credentialless`,
so a page that sends it has no embedder policy at all. Neither has
Document-Isolation-Policy or credentialless frames.

A host that sent `credentialless` (the demo did until 2026-11-19) was
therefore never isolated in WebKit, nor was any proxied page: a game that
needs SharedArrayBuffer (blockshooter.club/play-staging, COOP and
`require-corp`) ran natively in Safari and stopped at its isolation check
through the demo. The demo's page and every document and worker the service
worker serves now say `require-corp` (`SERVED_EMBEDDER_POLICY`, which
refuses nothing a proxied page loads: every one of its loads is the proxy's
own, of its origin).

The service worker decides each document, frame and worker script by the
rules of the browser it runs in (`IsolationEngine` in src/isolation.ts:
`credentialless`, `permission`, `dip`). It does not guess the browser from
its name: where the rules of some engine would decide otherwise than
Chrome's (`byEngine`, which tries every combination), it asks the
controller's page once, and that page asks the browser
(src/controller/isolationProbe.ts). A dedicated worker and two hidden
frames of its own load what the service worker answers itself
(`coi~probe/c`, `p`, `d`), and a third tells whose an about:blank is
(`blank`): a data: frame whose child its parent navigates to about:blank
(the controller's document reaches it in Chrome and Firefox, not in
WebKit; the service worker reads the answer at `coi~probe/b`). The worker's script sends COEP
`credentialless`, and the worker is isolated only where the browser has
that policy. A frame cannot ask that: WebKit checks no embedder policy of
a frame's document that a service worker answered (measured, WebKitGTK
2.52.4: a frame with `credentialless`, or with none, loads isolated under
an isolated page), though it refuses the same document from the network.
The frames have `allow="cross-origin-isolated 'none'"`: one with
`require-corp` is isolated only where the browser has no such permission;
one with a Document-Isolation-Policy is out of the page's reach, and says
it is isolated in a message, only where the browser has that policy. In a
page that is not isolated only the last is asked (the rest is moot there).
An answer that does not come in time leaves Chrome's rules.

What the browser still isolates and the page should not be, the inject
answers for: the shell marks a document that is not isolated natively
(`n` among its facts), and its `crossOriginIsolated` reads false and its
SharedArrayBuffer global is gone. A dedicated worker it starts is told the
same: its route kind says so (`js:worker:n`, src/partition.ts workerKind),
or for a blob: or data: worker what its bootstrap runs first
(`notIsolated()`), and the worker's client answers alike and passes it on
to its own workers. A `credentialless` attribute makes a credentialless
frame only where the browser's frames have that property (Chrome).

A blob: worker's bootstrap imports the page's script through the service
worker, which reads the page's Blob at a private blob: URL of it, as it
reads a blob: script or stylesheet. In a frame of another site's page (the
isolated mode) Firefox and WebKit refuse the worker's fetch() of a blob:
URL the frame minted (Firefox NetworkError, WebKit "Load failed"), and
WebKit's worker cannot read a Blob posted to it there either
(NotFoundError), so the worker failed to start and the script did not run.
The frame's own request is read: the realm that routes a load to a private
URL hands the Blob over as the body of a POST to `blob~bytes/<uuid>`
(src/inject/modules/ObjectURL.ts), which the service worker keeps as that
realm's real origin's (handedBlobs in src/server/rewrites.ts, 64 MiB, the
oldest first) and reads when its own fetch() fails. Whether it reads its
clients' blob: URLs itself (Chrome, and a first-party page anywhere) it
learns as the first load of a page's Blob comes, from a blob: URL the
controller's document mints for it (`blobProbe`, learnBlobsReadable in
src/server/rewrites.ts), else from the first bytes handed over; then it
answers 204, the realm hands no more, and it asks for none. A blob: document goes the same way: the Blob posted with its inline
document (src/server/inline.ts) is one WebKit's worker cannot read, so its
bytes go with it, under the inline token. A load named by its blob: URL
alone (a static import of a blob: module, which the worker routes as it
rewrites the importer) has no private copy: the worker asks the realms that
may hold its Blob (its minter, as BLOB_MINTED recorded it, else the realm
that loads it) for the bytes in a message (BLOB_ASK): it hands them over as
above, or says it holds none (the page revoked the URL), and the load fails
at once, as natively. A window and a dedicated worker both
hear such a message in Firefox and WebKit (measured; a worker once it
started its container's messages). A Chrome worker hears none, and before
the worker learned up front that it needs no bytes there, a worker's
import() of a blob: URL it had revoked waited 3 s for an answer in a
service worker that had served no Blob yet (blob-worker-revoked). Nothing is handed over until the
worker could not read a URL, so Chrome pays only a listener. The
coi-engines suite starts a classic and a module blob: worker, runs a blob:
script, a blob: module's static import of another blob: module and a frame
of a blob: document in every engine and mode.

What a page asks for synchronously (a synchronous XMLHttpRequest,
localStorage, document.cookie, a script written into a document no service
worker controls) goes through the synchronous bridge, whose answer the
service worker sets in cookies while the page spins on document.cookie.
The browsers differ in what a spinning page lets through (measured natively
in Firefox 160, Chrome 157 and WebKitGTK 2.52.4):

| While the page spins                              | Chrome | Firefox            | WebKit                                    |
| ------------------------------------------------- | ------ | ------------------ | ----------------------------------------- |
| A cookie the worker sets reaches document.cookie  | yes    | not before the end | no (the worker's `cookieStore.set` waits) |
| The worker's `clients.get` of the page            | yes    | not before the end | not before the end                        |
| The page's synchronous request reaches its worker | no     | yes                | no                                        |

In Firefox a document therefore also asks for each answer with a
synchronous request of its own (src/inject/dom/syncAnswer.ts), which the
worker answers in the body; before, a request there took 30 s and came
back with status 0, localStorage 10 s, and a written script 5 s. An
about:srcdoc frame under a sandboxed frame has no service worker in
Firefox, even with `allow-same-origin`, nor does one whose `srcdoc` was set
after the frame was in the document, so a proxied srcdoc document there
(the host's frame is sandboxed) is one no worker controls, as natively, and
its scripts go through the bridge. In WebKit no answer reaches a waiting
page yet (sync-engines: on the known list).

## Left

Ranked by what a page could learn or do. Measured ones are listed in the
suites' known lists with the same reason.

1. **A video or sound copied for a document no service worker controls
   keeps a `blob:` URL the page's process can fetch.** The rest of the gate
   between page and worker is closed (the load gate, above). A media
   element's loads go on after the first: a seek into what it has not
   buffered, a replay. Chrome resolves the `blob:` URL again for each, and
   has no other way to hand an element a Blob (measured in plain Chrome 152
   and 156: `video.srcObject = blob` throws "TypeError: Failed to set the
   'srcObject' property on 'HTMLMediaElement': The provided value is not of
   type '(MediaSourceHandle or MediaStream)'"; revoking the URL as soon as
   it is set gives error code 4; revoking it after `loadedmetadata` leaves
   a 4 MB video stalled on a seek to 95% and a 300 MB one on any seek, with
   no error event). So the URL stays alive while the element shows it, and
   a realm without the inject's hooks that reads the attribute can fetch
   the bytes (sop-escapes: `gate/the URL a video of another site has ...`,
   on the known list). The bytes are a media file's: the worker hands a
   video's or sound's copy over only when its first bytes are a media
   container's, so a document, data or text of another site is not read
   this way (the element fires `error`, as natively). Closing it
   needs those loads to reach the service worker, which Chrome does not do
   for those documents, or MediaSource for every copied file, which plays
   only what it is fed in segments (fragmented MP4 and WebM, and in Chrome
   152 MPEG audio, AAC and MPEG-2 transport streams): a progressive MP4
   would need a remuxer in the inject. Measured on 56 media-heavy real
   pages (news, sports, ad-heavy publishers, video and audio sites), each
   loaded twice in plain Chrome 152: a video or sound of another site was
   loaded in a document no service worker controls on 3 of them, each time
   an ad's about:blank frame, and all 6 files were progressive MP4, which a
   MediaSource copy cannot play. The streaming players hand their element
   a MediaSource URL of their own, which STomp does not copy. So the live
   URL stays, and MediaSource would close this for none of the files
   measured.
   What the gate does not cover, since it is not the gate's: a realm
   without hooks is in the proxy's one real origin, so it reads what the
   browser renders there with the browser's own methods (a canvas it draws
   an image into, a sheet's rules), in a document the worker controls as
   much as in a copied one, and it can ask the worker for a transport
   (`INIT_REMOTE_TRANSPORT`), which is how a document's WebSocket works. A
   worker that restarted takes a client's channel with the nonce it
   challenged the client with, which the inject hears first: a realm that
   ran in that client before the inject's bundle would hear it before it.
   The defence against such a realm is that there is none (the escape
   suites); the gate is what holds when a hook is passed.
2. `:visited` for the visits a frame's history does not record (Visited
   links, "What is not recorded"): a replacement of the document's entry
   (`location.replace`, `replaceState`, a navigation before the load
   event, a meta refresh), the first document of a tab the host opens, a
   frame's `src` its page sets, and the navigations of a page that listens
   to the Navigation API. Each reads unvisited where Chrome shows it
   visited; none reads visited where Chrome would not.
3. Cross-origin isolation (the section above) needs the host's page to be
   isolated, which is the host's to send. What is not as natively under a
   host that is (the first two are on the suite's known list or measured by
   it):
   - A document with a Document-Isolation-Policy is isolated natively
     wherever it is; through the proxy it is isolated only inside an
     isolated group (a frame of an isolated page, or a page under an
     isolated host), and never under a host that is not isolated. Chrome
     152 and 156 both ship the header to pages. Measured natively (a page
     without headers and its same-origin frame that sends
     `isolate-and-require-corp`): the frame is isolated, and the two are
     cross-origin to each other although their origin is one:
     `contentDocument` null, a SecurityError for `contentWindow.document`,
     its `location.href` and `name`, and in the frame for `parent.document`
     and `parent.location.href`, `frameElement` null; `postMessage` both
     ways (`event.source` is the window, `origin` the page's), a
     BroadcastChannel, localStorage and cookies are shared as for any
     same-origin frame. The reach is emulated under any host (Chrome 157,
     the document-isolation suite): a document whose own policy isolates
     it and one of its origin that none isolates are other origins to each
     other's inject (`reachableClients`), so what stays open is the
     isolation alone. Serving the page's own header was measured too (the
     worker passing it on, Chrome 152): Chrome isolates the frame
     (`crossOriginIsolated` true, SharedArrayBuffer), and every proxied
     document around it can no longer reach it, nor it them. STomp's inject
     takes a real window it cannot reach for the host's page, the boundary
     above the proxied top: the frame read `top === self`,
     `parent === self`, `parent.frames.length` 0 and lost its name, its
     parent's messages and its own were dropped as the host's are
     (`Framing`), and its storage partition, which is decided by the
     proxied top it finds by walking up, came out as its own site's: a
     frame of another site would have read and written that site's
     first-party storage. So the header is not served. Matching Chrome
     needs a membrane for a proxied window that is of the proxy's origin and
     cannot be reached: the frame's route saying how many levels up its
     proxied top is (a cross-origin `parent` chain can be walked, its
     documents cannot), `top`, `parent`, `frames` and named access as
     cross-origin stand-ins that compare equal from both sides, the
     message envelope accepted from such a window and told apart from the
     host's, the partition, the site facts and the rewriter library taken
     from the route and the bundle instead of the top's realm, the joint
     session history (src/controller/history.ts and the History module walk
     the frames' realms) and, for a proxied top that sends the header, a
     `Frame` whose `url`, `title`, `back` and `forward` work without its
     window. Half of that is worse than the difference it removes (the
     partition above), so it stays on the cross-origin-isolation suite's
     known list until it is done whole.
   - A credentialless frame's partition (Fix status, Credentialless
     frames) is emulated, the attribute still never reaches the browser
     (the frame would lose the service worker's client otherwise). What
     differs: what it stored is not deleted when its top-level document
     goes (no document reaches it again, since every top-level document
     draws a nonce of its own, but the worker's stores and the jar keep it
     until the site's data is cleared); a script's SameSite=Lax or Strict
     cookie in a credentialless frame of the top's own site is dropped, as
     in any partition, where Chrome keeps it; under the site pool the
     nonce is drawn by the outermost proxied document in reach, so the
     credentialless frames of one top-level page in two slots are in two
     partitions; an image's renderer memory cache entry is the site's, as
     for any frame (the memory cache bullet in Fix status). Not measured:
     a link with `rel=opener` and a form aimed at `_blank` in such a frame.
   - No COOP or COEP report is sent (`report-to`, the Report-Only forms):
     nothing of the Reporting API is simulated.
   - Under an isolated host every popup is served COOP `same-origin` to
     stay in the host's group, and one that natively leaves its opener's
     group (`src/coop.ts`) is served without it instead (with a
     Document-Isolation-Policy when it is isolated natively), which takes
     it out of the group as Chrome does (popup-openers). Under a host that
     is not isolated the worker severs a popup with a policy of its own
     (`src/coop.ts`, the coop suite).
   - A `blob:` worker's loads are not judged by the embedder policy it
     inherits; an origin named in an iframe's `allow` is not the proxy's
     real one, for this feature as for every other (the feature reaches a
     frame by `*`, `'src'` and `'self'` only); the document that replaces
     itself on a frame's first navigation is what a page's own service
     worker sees as the referrer of the navigation that follows.
   - Under a host that is not isolated a page's COEP does nothing, as
     before: no frame or load is refused by it, and
     `document.featurePolicy` answers for `cross-origin-isolated` as the
     browser does for the proxied frame, not as for the page natively (the
     suite does not compare it there).
4. Smaller differences that are kept, none a read of another site's data:
   - The tracks of a stream captured from a canvas end when the canvas is
     tainted (a player of the stream shows nothing), where Chrome keeps
     them live and sends them no more frames (sop-escapes known list).
   - A media URL of the page's own origin whose load once came through
     another origin is another origin's for every element that names it
     (the worker's record and the timing mark are by URL), where Chrome
     judges each load.
   - `nextHopProtocol` is the scheme's usual protocol (`h2` for https,
     `http/1.1` for http): no transport reports what the origin spoke.
   - What the worker's HTTP cache keeps and asks the origin differs from
     Chrome's in one listed way (docs/http-cache.md), so those loads read
     as a network load where Chrome's entry says cache: an entry made with
     other credentials than the request's is confirmed or fetched again.
   - A kept script's entry in a worker (`importScripts`, a worker's own
     script) reads as the HTTP cache's however it was delivered: a worker
     hears no note and has no synchronous bridge.
   - Opaque response blocking is applied to scripts, where a page can tell;
     Chrome also empties other blocked no-cors responses, which a page
     cannot read anyway.
   - Network state STomp does not partition, none read across sites
     through a page: a request without credentials shares the connections
     of those with (Connections, above), and so does every request of a
     transport other than our epoxy build; DNS answers are the wisp
     server's resolver's, shared by every user of the relay; HSTS is not
     kept at all (the worker drops `Strict-Transport-Security`, which
     would pin the proxy's host), so an `http:` URL of a site that sent it
     loads over http where Chrome upgrades it (not measured locally:
     Chrome takes HSTS only over a certificate it trusts, which a test
     fixture does not have; Chrome's own HSTS store is not keyed by
     top-level site).
