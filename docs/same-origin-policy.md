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
  differ, and 33 read as natively now, the 3 left being the memory cache,
  Left 9). Natively a site framed by a frame of another site under
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

1. **The gate between page and worker is in the page, and cannot move out
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
2. Canvas: an image of the page's own origin that redirects to another is
   judged by its own URL (Chrome taints by the response's origin); a canvas
   tainted in one document's bundle is not known to another document's (a
   same-origin child frame's canvas drawn by its parent); a tainted
   ImageBitmap sent to a worker is clean there; `new VideoFrame()` of a
   tainting source is not refused. WebGL's texture uploads are hooked when
   the realm's first WebGL context is made (making the WebGL interfaces in
   every frame cost each about 90 KB of heap): a `texImage2D` the page took
   from a WebGL prototype before any context existed uploads a tainting
   source, and is not the function the prototype holds afterwards.
3. A no-cors response that went through another origin and came back (A to
   B to A) is `basic` and readable; natively it is opaque. B's redirect
   decides only that A's own resource is shown.
4. Resource timing: a fetch's or XMLHttpRequest's entry of another origin
   is restricted even when its Timing-Allow-Origin names the page (the mark
   would show in the response headers the page reads); a response the
   worker answers has no `transferSize` or `nextHopProtocol` of its own
   (every entry, the page's own origin's too).
5. An about:srcdoc document under a `no-referrer` policy is judged as an
   opaque origin: its client URL names no origin the worker can read and no
   Referer names one, so the worker fails closed. A CORS answer naming the
   document's real origin is refused where Chrome accepts it (`*` works).
6. An XMLHttpRequest with upload listeners is not preflighted for them
   (Chrome's CORS-preflight flag); the preflight cache is not keyed by the
   top-level site as Chrome's is.
7. `:visited`: Chrome never lets script read it, and partitions it by
   top-level site and frame origin; through the proxy every link is a
   proxy URL in one partition, so its timing side channels span every
   proxied site.
8. `crossOriginIsolated`: a page that sends COOP and COEP natively gets an
   isolated agent cluster (SharedArrayBuffer, precise timers); through the
   proxy the frame lives in the host's browsing context group, so it
   cannot.
9. The renderer's memory cache is one for every proxied site
   (sop-partitions: 3 cases per mode). Natively each site's documents are
   in a renderer process of their own, whose memory cache answers a
   resource that site loaded before; through the proxy every site's
   documents are in one process, so an image another site loaded is
   answered from memory (another site's page, a third site's frame: 1 load
   reached the site where Chrome makes 2 and 3). A routed URL is the same
   for every site, and the browser never asks the worker. Fixing it would
   take the browser coming back to the worker for each document's
   subresources (a `no-cache` on what it is handed) and a memory cache per
   site in the worker, a round trip per subresource, and a refetch when
   the HTTP cache is off.
