# The same-origin policy through the proxy

**Measured 2026-11-10 against Chrome 152, both demo modes.**

Every proxied site shares one real origin: the proxy's. In same-origin mode
that is also the host's; isolated mode (`RemoteController`) moves the host to
an origin of its own, but the proxied sites still share the proxy's. So the
browser enforces nothing between two proxied sites: to Chrome a request from
one to the other is same-origin, an image of one drawn by the other is
same-origin, and their storage is one origin's. Stomp has to simulate the
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
  every store. Natively the frame's stores are keyed by the top-level site
  too (Chrome's third-party storage partitioning, which Playwright turns off;
  the suite turns it back on).

Both suites keep a list of the cases known to differ, each with its reason;
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
| `fetch` from an about:srcdoc document under `no-referrer`                                                                                       | judged as the parent's origin                                                      | readable without CORS                                                          | judged as an opaque origin: CORS applies (see Left)                                |

### 2. Resource-level policy

| Behaviour                                                                                                                                      | Chrome                                                                     | Before                                     | Fix                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `Cross-Origin-Resource-Policy: same-origin` / `same-site` on an image of another site; on a no-cors fetch                                      | load fails / TypeError                                                     | loads, readable (the worker stripped CORP) | worker checks CORP on no-cors responses before stripping it |
| `<img crossorigin>` without ACAO; `use-credentials` with ACAO `*`                                                                              | load fails                                                                 | loads                                      | the CORS check covers every `cors` mode load                |
| `<script crossorigin>` without ACAO; a module script of another site without ACAO                                                              | `error`                                                                    | runs                                       | as above                                                    |
| A font of another site without ACAO                                                                                                            | NetworkError                                                               | loads                                      | as above (fonts are `cors` loads)                           |
| Canvas tainting: `drawImage` of a cross-origin image (also scaled, through a pattern, an ImageBitmap, another tainted canvas, OffscreenCanvas) | `toDataURL`, `toBlob`, `getImageData`, `convertToBlob` throw SecurityError | **leak**: pixels readable                  | inject taints the canvas                                    |
| WebGL `texImage2D` of a cross-origin image                                                                                                     | SecurityError                                                              | uploads                                    | inject refuses tainted sources                              |
| Muted errors of a cross-origin classic script                                                                                                  | "Script error.", no location                                               | as natively (Unroute's muted check)        |                                                             |
| `Timing-Allow-Origin` on resource timing                                                                                                       | without it: no timing details, sizes 0, `responseStatus` 0                 | every detail of another site's resources   | inject restricts entries (see Fix status)                   |
| `crossOriginIsolated`; COOP and COEP                                                                                                           | false without COOP+COEP                                                    | false; COOP, COEP stripped                 | structural (see Left)                                       |

### 3. Storage and messaging partitions

| Store                                                                                                                                | Chrome                        | Before                                                                                                           | Fix                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| localStorage, sessionStorage                                                                                                         | per origin                    | per proxied origin (worker-side store keyed by origin)                                                           |                           |
| IndexedDB, Cache Storage, OPFS                                                                                                       | per origin                    | per proxied origin (names suffixed)                                                                              |                           |
| BroadcastChannel                                                                                                                     | per origin                    | per proxied origin                                                                                               |                           |
| Cookies, `document.cookie`                                                                                                           | per site/host                 | per real host in the worker's jar                                                                                |                           |
| Web Locks                                                                                                                            | per origin                    | **leak**: one namespace for every proxied site: a lock B holds is held for A, and `query()` lists B's lock names | names scoped by origin    |
| `navigator.storage.estimate()`                                                                                                       | the origin's usage            | counts every proxied site's usage (a megabyte B wrote shows in A's)                                              | see Left                  |
| Third-party partitioning: B framed by A shares nothing with B top-level (localStorage, IndexedDB, caches, OPFS, locks, SharedWorker) | partitioned by top-level site | shared                                                                                                           | key by top-level site too |
| CHIPS (`Partitioned` cookies)                                                                                                        | kept per top-level site       | one jar, `Partitioned` ignored                                                                                   | jar partitions (see Left) |

### 4. Document-level policy

| Behaviour                                                            | Chrome                                                                                         | Before                                                             | Fix                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `window.origin`, `self.origin`, `location.origin`, `isSecureContext` | the page's                                                                                     | as natively                                                        |                                           |
| `document.domain` setter                                             | host-parsed value (`0.0.1` is `0.0.0.1`, an IP host only to itself, `''` "is an empty domain") | accepted `0.0.1`; other messages                                   | setter parses the value as a host         |
| `postMessage` targetOrigin, `event.origin`                           | per origin                                                                                     | as natively                                                        |                                           |
| `document.referrer`, Referrer-Policy                                 | per policy                                                                                     | as natively (referrer and wpt-referrer-policy suites)              |                                           |
| `navigation.entries()` across origins                                | only the contiguous same-origin entries                                                        | **leak**: B sees A's entry, its full URL included, and `canGoBack` | entries filtered to the document's origin |
| `:visited`                                                           | partitioned by top-level site and frame origin; never readable by script                       | every proxied link is a proxy URL in one partition                 | see Left                                  |

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
  46 cases that differed read as natively in both modes, one srcdoc case
  now differs the other way, see Left). The service worker (`src/server/cors.ts`,
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
  no body, no URL). The inject's own copies of a page's loads say which load
  they stand for (`x-stomp-load`) and are judged as that load; the page's
  own requests never carry the proxy's headers (fetch, Request and
  XMLHttpRequest drop them). A synchronous XMLHttpRequest the policy
  refuses throws NetworkError, as natively. Cost: nothing on a same-origin
  request; a preflight is the round trip Chrome makes too.

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
  texture. Cost: a draw is a WeakSet lookup on a canvas that is tainted
  already, else a WeakMap lookup and a native getter call; 200,000
  `drawImage` calls of a same-origin image took 280 to 340 ms natively and
  295 to 320 ms proxied (noise).

## Left

Ranked by what a page could learn or do.

- Canvas: an image of the page's own origin that redirects to another is
  judged by its own URL (Chrome taints by the response's origin); a canvas
  tainted in one document's bundle is not known to another document's (a
  same-origin child frame's canvas drawn by its parent); a tainted
  ImageBitmap sent to a worker is clean there; `new VideoFrame()` of a
  tainting source is not refused.
- An about:srcdoc document under a `no-referrer` policy is judged as an
  opaque origin: its client URL names no origin the worker can read and no
  Referer names one, so the worker fails closed. A CORS answer naming the
  document's real origin is refused where Chrome accepts it (`*` works).
- A no-cors response that went through another origin and came back (A to
  B to A) is `basic` and readable; natively it is opaque. B's redirect
  decides only that A's own resource is shown.
- The Cache API keeps an opaque response as the empty one the worker sent:
  read back from the cache it is `basic`, status 200, empty.
- `navigator.storage.estimate()` counts every proxied site's usage. The
  browser keeps one quota for the proxy origin; per-site usage would need
  the proxy to account every store's size itself.
- Third-party partitioning and CHIPS.
- `:visited`: Chrome never lets script read it, but its timing side channels
  span every proxied site.
- `crossOriginIsolated`: a page that sends COOP and COEP natively gets an
  isolated agent cluster (SharedArrayBuffer, precise timers); through the
  proxy the frame lives in the host's browsing context group, so it cannot.
