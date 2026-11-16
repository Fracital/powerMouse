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

| What the page reads                                                    | Natively                                                                                                                                                | Where it comes from                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                 | the URL the page asked for                                                                                                                              | the routed name, unrouted (`Unroute`)                                                                                                                                                       |
| which entries exist                                                    | one per load; none for a second use of what the document has; none for what a style sheet of another origin loads when the sheet was taken without cors | the proxy's own requests are left out (`Unroute`); a repeat the renderer's memory cache would have answered is left out; the worker marks an opaque sheet's loads (`stomp-unreported`)      |
| `transferSize`, `deliveryType`, `nextHopProtocol`                      | by how the load was delivered: the network, the memory cache, the HTTP cache, a revalidation                                                            | the worker's marks for what its own caches answered (`stomp-cached`, `stomp-revalidated`, `stomp-memory`, and the note of a kept script, `src/server/keptLoads.ts`); see docs/http-cache.md |
| `encodedBodySize`, `decodedBodySize`                                   | the bytes of the origin's body as it came, and decoded                                                                                                  | `stomp-size`: the origin's Content-Length and the bytes the worker read before it rewrote them                                                                                              |
| `contentEncoding`                                                      | the origin's, when the response is the page's to read (its own origin's, or a cors answer)                                                              | the header; for a cors answer of another origin, which the page may not read as a header, `stomp-encoding`                                                                                  |
| `responseStatus`, `contentType`                                        | the origin's, when the response is the page's to read; 0 and "" for a no-cors load of another origin                                                    | `stomp-cors` on another origin's answer to a cors request, `stomp-opaque` on a no-cors chain that left the page's origin                                                                    |
| every time and size of another origin's load                           | 0 unless every hop of its redirect chain names the page in Timing-Allow-Origin                                                                          | `stomp-tao` when the chain allowed it, `stomp-tao-denied` when a hop did not (the entry's name may be the page's own origin's)                                                              |
| `fetchStart`, `domainLookup*`, `connect*`, `requestStart`              | from `startTime` (after the redirects, when there were any), in order                                                                                   | the browser's own, moved to where the load started: a service worker's answer has them after the worker was asked                                                                           |
| `redirectStart`, `redirectEnd`                                         | `startTime` and the last redirect's end when every hop allows it, else 0                                                                                | the browser's own, put in order (a redirect a service worker answers has its start after its end)                                                                                           |
| `firstInterimResponseStart`, `finalResponseHeadersStart`               | network and revalidated: 0 and `responseStart`; HTTP cache: `responseStart` and 0; memory cache and a dedicated worker's script: 0 and 0                | by the delivery; the browser gives a service worker's answer the HTTP cache's shape                                                                                                         |
| `workerStart`, `workerRouterEvaluationStart`, `workerCacheLookupStart` | 0: the page has no service worker                                                                                                                       | 0                                                                                                                                                                                           |
| `serverTiming`                                                         | the origin's metrics, none for a restricted entry                                                                                                       | the origin's, without the worker's marks                                                                                                                                                    |
| `initiatorType` of an `XMLHttpRequest`                                 | `xmlhttprequest`                                                                                                                                        | `stomp-xhr` (the inject makes the request with `fetch`)                                                                                                                                     |
| `toJSON()`                                                             | the same keys in the same order, the getters' values                                                                                                    | the browser's object with each hooked field replaced                                                                                                                                        |

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
