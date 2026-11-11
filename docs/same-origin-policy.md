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

| Behaviour                                                            | Chrome                                                                                         | Before                                                             | Fix                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `window.origin`, `self.origin`, `location.origin`, `isSecureContext` | the page's                                                                                     | as natively                                                        |                                           |
| `document.domain` setter                                             | host-parsed value (`0.0.1` is `0.0.0.1`, an IP host only to itself, `''` "is an empty domain") | accepted `0.0.1`; other messages                                   | setter parses the value as a host         |
| `postMessage` targetOrigin, `event.origin`                           | per origin                                                                                     | as natively                                                        |                                           |
| `document.referrer`, Referrer-Policy                                 | per policy                                                                                     | as natively (referrer and wpt-referrer-policy suites)              |                                           |
| `navigation.entries()` across origins                                | only the contiguous same-origin entries                                                        | **leak**: B sees A's entry, its full URL included, and `canGoBack` | entries filtered to the document's origin |
| `:visited`                                                           | partitioned by top-level site and frame origin; never readable by script                       | every proxied link is a proxy URL in one partition                 | link routes (Visited links)               |

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
  too, `github.io` to a page of its customer) with Chrome's messages, and then
  does nothing: a document is in an origin-keyed agent cluster by default
  (`window.originAgentCluster`), where Chrome's setter has no effect. It
  used to accept a parent domain and read it back.
- **A document's identity is its own URL, never its base URL.** The inject
  resolved a URL the page writes and decided whose a document was from one
  URL, which followed the document's `<base href>`: a page of one site that
  named another site's page as its base was that site to its stores and to
  the membrane. It read the other site's `localStorage`, IndexedDB and
  cookies, its frames' documents were its own to read, and theirs it
  (base-identity suite, natively against both modes). A document's `url` is
  now its own (a routed document's route, what the shell of a document the
  page made named, an about:blank or srcdoc document's maker's), and what a
  URL it writes resolves against is its `baseURL`.
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
  a (each used to set all four). Still different, for every suffix, and
  listed in site-facts: Chrome holds a window by its document's origin, so
  a page and a frame of its site on another host read nothing of each
  other, where the membrane compares sites and lets them; and a response's
  `Origin-Agent-Cluster: ?0` is not read, so `originAgentCluster` stays
  true and `document.domain` never takes effect (with the header and the
  same `document.domain` on both sides Chrome lets the two read each
  other, which the membrane allows anyway).
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
  srcdoc client claims it (SRCDOC_CLAIM); the worker binds the claiming
  client id to the voucher's origin and partition (`srcdocVouches.ts`, kept
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
  - Cost: frame-cost 1070 KB of heap a frame (1064 before, ceiling 1120),
    the bundle 816 KB (809, ceiling 850); an about:blank frame with fifty
    images of another site loads in 48 ms (median of 9; 47 to 62 before,
    44 to 55 natively: no difference outside the runs' noise), one worker
    for the fifty.

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

- Every document and worker script gets COEP `credentialless` and CORP
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
  isolated host: under any other a page's COEP does nothing, as before.
- `document.featurePolicy` answers for `cross-origin-isolated` with the
  page's permission and origin (`allowsFeature`, `getAllowlistForFeature`,
  `allowedFeatures` in the native order); the real policy would show the
  denial the worker added.

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

| The page                                                                                                   | Chrome     | STomp, isolated host                         | STomp, host not isolated |
| ---------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------- | ------------------------ |
| COOP `same-origin` and COEP (either value, parameters or not)                                              | isolated   | isolated                                     | not                      |
| The same and `Permissions-Policy: cross-origin-isolated=()`                                                | not        | not                                          | not                      |
| No headers, one of the two, another COOP value, a Report-Only form, a malformed value                      | not        | not                                          | not                      |
| A Document-Isolation-Policy                                                                                | isolated   | isolated                                     | not                      |
| Its dedicated workers (script with COEP, `blob:`, nested)                                                  | as it is   | as it is                                     | not                      |
| Its dedicated worker whose script has no COEP, when it has one                                             | `error`    | `error`                                      | runs, not isolated       |
| Its shared workers                                                                                         | not        | not                                          | not                      |
| Its frame without COEP (or, from another origin, CORP), when it has COEP                                   | no load    | no load                                      | loads, not isolated      |
| Its same-origin frame with COEP; another origin's with COEP, CORP and `allow`; about:blank, `srcdoc`       | as it is   | as it is                                     | not                      |
| Its frame the permission does not reach (another origin without `allow`, `allow` `'none'`, its own header) | not        | not                                          | not                      |
| Its credentialless frame                                                                                   | as above   | as above (with the site's cookies, see Left) | not                      |
| A frame with a Document-Isolation-Policy in a page that is not isolated                                    | isolated   | not                                          | not                      |
| `require-corp`: its no-cors load of another origin without CORP                                            | fails      | fails                                        | loads                    |
| `credentialless`: the same load                                                                            | no cookies | no cookies                                   | with cookies             |

### What a host does

Its own page (the one that holds the controller) sends

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

(`require-corp` isolates as well; under it everything the host's own page
loads from another origin must send a CORP). The files of `dist/` and the
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
     same-origin frame. Serving the page's own header was measured too (the
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
   - A credentialless frame has its site's cookies and stored data, where
     Chrome gives it none, and `iframe.credentialless` reads false: the
     attribute never reaches the browser (as before; the frame would lose
     the service worker's client otherwise).
   - No COOP or COEP report is sent (`report-to`, the Report-Only forms):
     nothing of the Reporting API is simulated.
   - COOP's own effect is not simulated, as before: a popup without the
     headers that an isolated page opens keeps its opener, where Chrome
     severs it.
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
