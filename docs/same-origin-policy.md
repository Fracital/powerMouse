# The same-origin policy through the proxy

**Measured 2026-11-10 against Chrome 152, both demo modes.**

After the fixes below, every cross-site read the two suites try fails as it
does natively, in both modes; what still differs is under Left, first of
all third-party storage partitioning.

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
  texture. Cost: a draw is a WeakSet lookup on a canvas that is tainted
  already, else a WeakMap lookup and a native getter call; 200,000
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
  (`'localhost' is a top-level domain.`) with Chrome's messages, and then
  does nothing: a document is in an origin-keyed agent cluster by default
  (`window.originAgentCluster`), where Chrome's setter has no effect. It
  used to accept a parent domain and read it back.
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
  response with its type, in a page and in a worker.
- **Output reuse** (`recentOutputs`, master's speed series): the worker
  gives a document the output it just gave it for the same request only
  when everything the policy decides by is the same: the client (its
  origin), mode, credentials, the inject's copy marker, the opaque-origin
  marker and the page's headers that need a preflight; never for a hop of
  a redirect chain, whose origin may be "null" by then. A refused request
  is never kept. (sop-escapes: a script of another site plain then
  `crossorigin` without CORS, and the other way.)

## Left

Ranked by what a page could learn or do. Measured ones are listed in the
suites' known lists with the same reason.

1. **Third-party storage partitioning and CHIPS** (sop-partitions: 14
   checks in each mode). A site framed by another shares localStorage,
   sessionStorage, IndexedDB, Cache Storage, OPFS, Web Locks and its shared
   workers with its own top-level pages, and a `Partitioned` cookie is kept
   in one jar for every top-level site. Natively each is keyed by the
   top-level site too. This is one site's own data seen across contexts
   (tracking and fidelity), not one site reading another's. The shape of the
   fix: one partition key per client (the origin, plus `^<top-level site>`
   when that site differs, from the document's `topOrigin`) used by every
   suffix the Partition, IndexedDB, Storage and Worker modules add today,
   handed to dedicated and shared workers by their creator before any page
   code runs in them (a blob: worker's bootstrap already carries its base;
   a routed worker would need it in its route), and a partition key on
   each jar cookie set with `Partitioned`, matched against the request's
   top-level site, which the worker knows from the nested route.
2. **`navigator.storage.estimate()`** counts every proxied site's usage (a
   megabyte another site stored shows in this one's). The browser keeps one
   quota for the proxy origin; a per-site figure would need the proxy to
   account each store's size itself.
3. **The gate between page and worker is in the page, and cannot move out
   of it while the copies exist.** The worker exempts the inject's copies
   from CORS by their `x-stomp-load` marker (judged as the load they stand
   for: a no-cors image is read whole). The hooks drop the marker from the
   page's own requests and hand the browser the page's headers as a record
   read with the browser's own members, so a replaced iterator, getter or
   `Object.prototype.headers` adds nothing (sop-escapes measured both ways
   in before that). A realm no hook runs in could still send it. A secret
   only the inject holds was considered: the worker would hand it, over a
   MessagePort, once, to each client it served the shell to, before any of
   the page's script runs, and trust only a marker that carries it. It
   would stop a forged marker, but not what the marker grants. The copies
   exist because Chrome gives a document no service worker controls (an
   about:blank frame or popup the page builds) no worker at all, so the
   inject fetches each of its loads through a controlled ancestor and hands
   the element a `blob:` URL of the bytes. Those bytes are in the page's
   realm by construction: a realm that can forge the marker can just as well
   put another site's image into such a frame and read the `blob:` URL the
   copy left in the element's attribute. Taking the bytes out of the page
   needs those loads to reach the service worker themselves, which Chrome
   does not do for those documents (measured in plain Chrome 152,
   docs/scramjet-parity.md section 7),
   or no such documents, which pages build constantly. So the marker stays
   a page-side gate, hardened as above. (Also measured: a DevTools or
   extension isolated world's fetch does not reach the service worker at
   all; the proxy server answers it, 404.)
4. Canvas: an image of the page's own origin that redirects to another is
   judged by its own URL (Chrome taints by the response's origin); a canvas
   tainted in one document's bundle is not known to another document's (a
   same-origin child frame's canvas drawn by its parent); a tainted
   ImageBitmap sent to a worker is clean there; `new VideoFrame()` of a
   tainting source is not refused.
5. A no-cors response that went through another origin and came back (A to
   B to A) is `basic` and readable; natively it is opaque. B's redirect
   decides only that A's own resource is shown.
6. Resource timing: a fetch's or XMLHttpRequest's entry of another origin
   is restricted even when its Timing-Allow-Origin names the page (the mark
   would show in the response headers the page reads); a response the
   worker answers has no `transferSize` or `nextHopProtocol` of its own
   (every entry, the page's own origin's too).
7. An about:srcdoc document under a `no-referrer` policy is judged as an
   opaque origin: its client URL names no origin the worker can read and no
   Referer names one, so the worker fails closed. A CORS answer naming the
   document's real origin is refused where Chrome accepts it (`*` works).
8. An XMLHttpRequest with upload listeners is not preflighted for them
   (Chrome's CORS-preflight flag); the preflight cache is not keyed by the
   top-level site as Chrome's is.
9. `:visited`: Chrome never lets script read it, and partitions it by
   top-level site and frame origin; through the proxy every link is a
   proxy URL in one partition, so its timing side channels span every
   proxied site.
10. `crossOriginIsolated`: a page that sends COOP and COEP natively gets an
    isolated agent cluster (SharedArrayBuffer, precise timers); through the
    proxy the frame lives in the host's browsing context group, so it
    cannot.
