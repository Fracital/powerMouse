# The Performance APIs through the proxy

A page reads a great deal about its own loads through `performance`: every
entry of `performance.getEntriesByType('resource')`, the navigation entry,
`PerformanceObserver`. Natively each entry describes a load the browser made
over the network or from its caches. Through the proxy every load is a
service worker's answer on the proxy's origin, and the browser's entries
describe that: routed names, no protocol, the sizes of rewritten text, a
`workerStart`, every origin same-origin. The inject shows the page what the
same page loaded natively would read, from what the service worker tells it
about each load.

The `performance-*` suites are the measurement: a fixture page
(`test/perf-server.mjs`, `test/pages/perf-*.html`) is loaded natively a few
times and through the proxy in both demo modes, and each field that the
native runs agree on is compared (`test/perf.mjs`). Times change from run to
run, so an entry's times are compared by what does not: which are zero,
whether they are in order, which are equal.

## Resource timing

The service worker marks its answers with Server-Timing metrics of its own
(`src/transport/messages.ts`), which the browser copies into the entry and
the inject reads and never shows (`src/inject/modules/ResourceTiming.ts`;
a `fetch` or `XMLHttpRequest` reads its headers without them).

A site may name its own metrics like those (`stomp-cached`): before it adds
a mark, the worker escapes every name of the origin's header that starts
with `stomp-` to `stomp-!<rest>`, which no mark is, and the inject gives the
page the site's name back wherever it reads one (`PerformanceServerTiming`
`name` and `toJSON`, the header of a `fetch` or `XMLHttpRequest`;
`siteMetrics` in `src/transport/messages.ts`). An emulated service
worker's answer is not escaped again: its metrics came through the worker
already (performance-server-timing suite).

| What the page reads                                                                | Natively                                                                                                                                                                               | Where it comes from                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                             | the URL the page asked for                                                                                                                                                             | the routed name, unrouted (`Unroute`)                                                                                                                                                                                                                                                                                                         |
| which entries exist                                                                | one per load; none for a second use of what the document has; none for what a style sheet of another origin loads when the sheet was taken without cors                                | the proxy's own requests are left out (`Unroute`); a repeat the renderer's memory cache would have answered is left out; the worker marks an opaque sheet's loads (`stomp-unreported`)                                                                                                                                                        |
| `transferSize`, `deliveryType`, `nextHopProtocol`                                  | by how the load was delivered: the network, the memory cache, the HTTP cache, a revalidation                                                                                           | the worker's marks for what its own caches answered (`stomp-cached`, `stomp-revalidated`, `stomp-memory`, and the note of a kept script, `src/server/keptLoads.ts`); see docs/http-cache.md. The protocol is the one the transport says the origin's answer came over (`stomp-protocol`: `h3`, `h2`, `http/1.1`), else the scheme's usual one |
| `encodedBodySize`, `decodedBodySize`                                               | the bytes of the origin's body as it came, and decoded                                                                                                                                 | `stomp-size`: the bytes the transport counted before it decoded the body (our epoxy build, stomp-h3) or else the origin's Content-Length, and the bytes the worker read before it rewrote them; a body passed on as it came has the browser's count                                                                                           |
| `contentEncoding`                                                                  | the origin's, when the response is the page's to read (its own origin's, or a cors answer)                                                                                             | the header; for a cors answer of another origin, which the page may not read as a header, `stomp-encoding`                                                                                                                                                                                                                                    |
| `responseStatus`, `contentType`                                                    | the origin's, when the response is the page's to read; 0 and "" for a no-cors load of another origin                                                                                   | `stomp-cors` on another origin's answer to a cors request, `stomp-opaque` on a no-cors chain that left the page's origin                                                                                                                                                                                                                      |
| every time and size of another origin's load                                       | 0 unless every hop of its redirect chain names the page in Timing-Allow-Origin                                                                                                         | `stomp-tao` when the chain allowed it, `stomp-tao-denied` when a hop did not (the entry's name may be the page's own origin's)                                                                                                                                                                                                                |
| `fetchStart`, `domainLookup*`, `connect*`, `secureConnectionStart`, `requestStart` | from `startTime` (after the redirects, when there were any), in order; a fresh connection's lookup, connect and TLS; all at `fetchStart` on a connection that carried a request before | the transport's own times for the connection (`stomp-connection`: our epoxy build, Http3Transport) from where the page's fetch started; without them the browser's own, moved to where the load started                                                                                                                                       |
| `redirectStart`, `redirectEnd`                                                     | `startTime` and the last redirect's end when every hop allows it, else 0                                                                                                               | the browser's own, put in order (a redirect a service worker answers has its start after its end)                                                                                                                                                                                                                                             |
| `firstInterimResponseStart`, `finalResponseHeadersStart`                           | network and revalidated: 0 and `responseStart`; HTTP cache: `responseStart` and 0; memory cache and a dedicated worker's script: 0 and 0                                               | by the delivery; the browser gives a service worker's answer the HTTP cache's shape                                                                                                                                                                                                                                                           |
| `workerStart`, `workerRouterEvaluationStart`, `workerCacheLookupStart`             | 0: the page has no service worker                                                                                                                                                      | 0                                                                                                                                                                                                                                                                                                                                             |
| `serverTiming`                                                                     | the origin's metrics, none for a restricted entry                                                                                                                                      | the origin's, without the worker's marks                                                                                                                                                                                                                                                                                                      |
| `initiatorType` of an `XMLHttpRequest`                                             | `xmlhttprequest`                                                                                                                                                                       | `stomp-xhr` (the inject makes the request with `fetch`)                                                                                                                                                                                                                                                                                       |
| `toJSON()`                                                                         | the same keys in the same order, the getters' values                                                                                                                                   | the browser's object with each hooked field replaced                                                                                                                                                                                                                                                                                          |

A navigation entry inherits all of these, and an emulated service worker's
`importScripts` reads as its script cache's (nothing transferred, no encoded
bytes).

### Differences that remain

Each is listed in the suite that measures it, with its reason; a listed
difference that starts matching fails the suite.

- **A synchronous `XMLHttpRequest` has no entry.** It travels over the
  synchronous bridge (a beacon and cookies, AGENTS.md), which is the proxy's
  own machinery: the browser never made the load the page asked for, and an
  entry cannot be made.
- **On Chrome 152, an image in the markup that no cache may keep has two
  entries and is fetched twice** (measured: two requests reach the origin).
  Its parser asks again for what its preload scanner fetched; a rewritten
  script or style sheet is asked for again too, which the worker answers
  from what it just gave and the inject leaves out, but a body the worker
  passes through goes to the origin again. Chrome 156 asks once, as
  natively, so this is that version's behaviour and not the proxy's
  design; the versions between were not measured. The suite lists it for
  Chrome 152 only.
- **An interim response (103 Early Hints) is not seen.** The transport hands
  the worker the final response only, so `firstInterimResponseStart` is 0
  and `finalResponseHeadersStart` is `responseStart`.
- **A body that came compressed without a Content-Length** (a chunked
  answer) counts as its decoded bytes in `encodedBodySize` and
  `transferSize`: the transport decodes it and does not say how long it was.
- **A worker's entry for a script the rewrite cache kept reads as the HTTP
  cache's** when the origin sent the script again: the kept response cannot
  say how the load was delivered, and a worker has no bridge to be told on
  (`src/server/keptLoads.ts`).
- **An emulated service worker's `importScripts` entry has no
  `finalResponseHeadersStart`.** Natively it has the times of a network load
  with the sizes of a cache's.
- **A srcdoc frame's navigation entry has the sizes of the shell** the
  proxy wrote into the frame, not of the page's `srcdoc` text.

## Navigation timing (performance-navigation suite)

The fixture walks itself through a plain navigation, two redirects of its
own origin, a redirect through another origin, a navigation from another
origin's document, a reload, a document with Server-Timing and a step back,
then loads documents in frames through the same kinds of redirect.

| what the page reads                                                                            | natively                                                                         | what the browser has through the proxy                            | where it is made right                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `type`, `name`, `redirectCount`, `redirectStart`/`End`, `serverTiming`                         | the navigation's                                                                 | the routed URL, the worker's own redirects counted                | Unroute.ts, ResourceTiming.ts (before this page)   |
| `unloadEventStart`/`End` after another origin's document, or a redirect through another origin | 0                                                                                | the previous document's: every document is the proxy's origin     | `src/inject/dom/modules/NavigationTiming.ts`       |
| `performance.timing.toJSON()` redirect and unload times, `performance.navigation.toJSON()`     | what the getters answer                                                          | the browser's own values (the worker's redirects)                 | NavigationTiming.ts                                |
| `confidence` of a top-level document                                                           | an object (`randomizedTriggerRate` 0.4994798, `value` high or low), new per read | null: a proxied top is a frame of the host                        | NavigationTiming.ts (a stand-in, value drawn once) |
| a frame's document after another origin's                                                      | no unload times                                                                  | none either: the frame is given a fresh context (freshContext.ts) | nothing to do                                      |
| `notRestoredReasons`, `activationStart`, `type` after Back                                     | null, 0, `back_forward` (see below)                                              | the same                                                          | nothing to do                                      |

The unload times are decided when first read, from the page's own view of
where it came from: `navigation.activation.from` is null for another
origin's document (the Navigation API's hooks hide it, as natively), and
the worker marks a navigation whose site's redirects crossed origins.

Not measurable in the harness, so not compared:

- The back/forward cache. Playwright starts Chrome with
  `--disable-back-forward-cache`, so natively a step back loads the
  document again (`type` is `back_forward`, `notRestoredReasons` null), which
  is what a proxied frame always does: a frame's document is never kept in
  the cache. A user's own Chrome may restore the page instead, with no new
  navigation entry and `pageshow.persisted`; a proxied page never is.
- Prerendering. Speculation rules do not start a prerender in headless
  Chrome (measured, 152 and 156: `activationStart` 0), and a frame cannot
  be prerendered, so a proxied page never reads a nonzero
  `activationStart`.

## Entry types (performance-entries suite)

The fixture makes one entry of every type a page can make without a GPU:
paints, the largest contentful paint, element timing (text, images of its
own and another origin, a background image), marks and measures, long
tasks of its own and of frames (its own origin, another site, another
origin of one site), a long animation frame from each kind of script, and,
after the suite clicks and types, the first input, event timing and a
layout shift.

An entry that is not a load's reaches a page through a list
(`performance.getEntries*`, an observer's list, `takeRecords`). The inject
looks at each entry there, by type, and hooks the entry's interface the
first time one of the type comes, from the entry itself
(`src/inject/dom/modules/EntryTiming.ts`): a frame that never has a long
task never names `PerformanceLongTaskTiming`, as natively.

| what the page reads                                                              | natively                                                          | what the browser has through the proxy                                                                                                                                                                         | where it is made right                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `LargestContentfulPaint.url`, `PerformanceElementTiming.url` (and `toJSON`)      | the image's URL                                                   | its routed URL                                                                                                                                                                                                 | EntryTiming.ts                               |
| a long animation frame's `scripts[]`: `sourceURL`, `invoker`                     | the script's URL; `IMG[src="/as/written.png"].onload`             | the routed URL; the routed `src`                                                                                                                                                                               | LongFrames.ts                                |
| a long animation frame's `scripts[]`: `sourceCharPosition` of a script file      | the function's place in the page's text                           | its place in the rewrite, which carries the map of itself to the page's text (rust/rwjs/src/positions.rs)                                                                                                      | LongFrames.ts, positionMaps.ts               |
| scripts of the host's page, another tab, a frame of another origin               | not listed (another origin's scripts never are)                   | could be listed, each with its `window`: a frame lists the scripts of other windows of its origin that ran in it (measured natively with a same-origin frame's function), and every proxied site is one origin | LongFrames.ts (not pinned by a fixture case) |
| the inject bundle as a script                                                    | no such script                                                    | listed by its URL                                                                                                                                                                                              | LongFrames.ts                                |
| a long task of the page itself: `attribution[0]`                                 | `containerType` "window", no source, id or name                   | the host's frame element: "iframe", the routed URL (same-origin mode)                                                                                                                                          | LongTasks.ts                                 |
| a long task of a frame of the page's origin                                      | `same-origin-descendant`, `containerSrc` the attribute as written | the routed `src`                                                                                                                                                                                               | LongTasks.ts                                 |
| a long task of a frame of another site                                           | not reported (another process)                                    | `same-origin-descendant` with the frame's `src`, id and name                                                                                                                                                   | LongTasks.ts                                 |
| a long task of a frame of the page's site, another origin                        | `cross-origin-descendant`, `containerType` "window", nothing else | `same-origin-descendant` with everything                                                                                                                                                                       | LongTasks.ts                                 |
| a frame's own long task, its parent of another site                              | "window", nothing of the parent's element                         | "iframe" with the parent's `src`, id and name for it                                                                                                                                                           | LongTasks.ts                                 |
| an observer's callback for entries the page never sees                           | never runs                                                        | ran with an empty list                                                                                                                                                                                         | Unroute.ts                                   |
| `performance.mark('x', { detail: () => {} })`: the DataCloneError's message      | quotes the function's source                                      | quoted the rewritten source, with its mark                                                                                                                                                                     | Unroute.ts                                   |
| paints, visibility, marks, measures, event counts, the first input, event timing | as recorded                                                       | the same: nothing of the inject's shows (no mark, no measure, no entry, no count)                                                                                                                              | nothing to do                                |

### Differences that are left

Listed in the suite, which fails when one reads as natively:

- **A callback run from a promise the inject made** (the reaction to
  `fetch()`) is listed without a source (`sourceURL` empty, position -1)
  where natively it has the page's script: the browser records where the
  chain of reactions started, which is the inject's own continuation, and
  the page's callback runs in the same checkpoint. The inject's URL is
  never shown.
- **A handler of an element that is not in the document**
  (`new Image().onload`) is named by the element's whole URL
  (`IMG[src="http://site/a.png"].onload`) where natively it is the
  attribute as written: only an element in the document can be found again
  to read what the page wrote.
- **`interaction-contentful-paint`** entries are made for the main frame
  only, and a proxied page is a frame of the host: an observer of the type
  is never called.

In same-origin mode only (the host's page and the proxied page share a
frame tree and a process there; the mode is for development):

- **A long animation frame that ends in a rendering update** (an animation
  callback, an input handler, a load that paints) is reported to the local
  root's window, which is the host's: the proxied page has no entry for it.
- **A layout shift's `lastInputTime`** is kept by the local root: 0 in the
  proxied page.

Not closed and not listed (they are not the same from run to run, so no
suite can pin them):

- The proxy's own work runs on the page's thread: a document's first
  script can make a long animation frame or a long task where natively
  there is none. The frame is reported (the time did pass); the inject's
  scripts are not named in it.
- An ancestor's long task does not say which ancestor ran it: a frame
  takes it for its parent's.

## The buffer, clocks, memory and frames

`performance-buffer` fills the resource timing buffer at its default size
and at a small one, in the page, a frame and a worker, and reads the
`resourcetimingbufferfull` events, what each read lists and a buffered
observer's `droppedEntriesCount`. `performance-clocks` reads `timeOrigin`
against the wall clock and the grain of `performance.now()` in the page,
its frames and its workers, `performance.memory`, and, in a cross-origin
isolated page, `performance.measureUserAgentSpecificMemory()`.
`performance-frames` reads the timeline of frames the page makes itself
(read in the task that made them, a task later, after a `document.write`,
after removal). `performance-shapes` describes every interface and every
member the inject hooks: descriptors, names, lengths, sources, prototype
chains and the errors of a wrong receiver.

| what the page reads                                                | natively                                      | what the browser has through the proxy                                                       | where it is made right                          |
| ------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| the resource timing buffer, `resourcetimingbufferfull`             | the page's 250 entries (or its own size)      | one buffer for the page's entries and the proxy's own (bundles, bridge beacons, the library) | `src/inject/modules/ResourceBuffer.ts`, Unroute |
| a buffered observer's `droppedEntriesCount`                        | the page's dropped entries                    | the proxy's counted too                                                                      | Unroute.ts                                      |
| an about:blank frame's own loads                                   | in the frame's timeline                       | in the nearest controlled ancestor's, which made them                                        | Client.ts (`routedFetch`), Unroute.ts           |
| a synchronous request's deprecation report                         | made once a page, at the page's call          | none: the bridge opens no synchronous request                                                | XMLHttpRequest.ts, Unroute.ts                   |
| `measureUserAgentSpecificMemory()` attribution                     | the page's URLs, its frames' `src` as written | routes, routed `src`, the host's page, the controller's frame, the proxy's workers           | `src/inject/dom/modules/Isolation.ts`           |
| `getEntriesByName(Symbol())`                                       | the browser's TypeError                       | an empty list                                                                                | Unroute.ts                                      |
| `timeOrigin`, `now()`, a frame's and a worker's clock, their grain | as measured                                   | the same                                                                                     | nothing to do                                   |

### Differences that are left

- **`performance.memory` in a frame of another site** includes the page's
  allocations: every proxied site shares one renderer heap, and what the
  heap grew is no one site's to tell (docs/process-model.md).
- **A load an about:blank frame makes is not told to the frame's own
  `PerformanceObserver`** (nor to one made with the frame's constructor
  before anything ran in it, nor to a buffered observer in a removed
  frame's realm): the browser reports it to the ancestor that made it.
  The frame's `performance` lists it.
