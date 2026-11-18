# Vendored web-platform-tests

A bounded subset of [web-platform-tests](https://github.com/web-platform-tests/wpt)
(BSD 3-Clause, see `LICENSE.md`), run through the proxy by 40 `wpt-*` suites
as measurements: every page runs natively from the fixture and again inside a
proxied frame, and `test/wpt.mjs` compares the two testharness verdicts per
subtest against the expected-failure list in `expected/<suite>.json`. What is
still on those lists, and why, is in `BACKLOG.md`.

The suites, by area:

- cookies: `wpt-cookies`, `wpt-cookies-more`
- fetch: `wpt-fetch-metadata`, and for `fetch/api` `wpt-fetch-basic`,
  `wpt-fetch-cors`, `wpt-fetch-credentials-redirect`, `wpt-fetch-objects`,
  `wpt-fetch-abort`
- referrer policy: `wpt-referrer-policy`
- XMLHttpRequest: `wpt-xhr-cors`, `wpt-xhr-events`, `wpt-xhr-timeout`,
  `wpt-xhr-request`, `wpt-xhr-response`
- EventSource, beacons, WebSockets: `wpt-eventsource`,
  `wpt-eventsource-format`, `wpt-beacon`, `wpt-websockets`
- workers and storage: `wpt-workers-basics`, `wpt-workers-constructors`,
  `wpt-workers-scope`, `wpt-workers-semantics`, `wpt-workers-modules`,
  `wpt-webstorage`, `wpt-indexeddb`
- URLs, encodings, Content Security Policy: `wpt-url`, `wpt-url-elements`,
  `wpt-encoding-api`, `wpt-encoding-legacy`, `wpt-csp`
- html: `wpt-history`, `wpt-location`, `wpt-windows`, `wpt-script-element`,
  `wpt-script-timing`, `wpt-modules`, `wpt-document-write`,
  `wpt-event-handlers`, `wpt-base-urls`
- dom: `wpt-dom-insertion`

Upstream commit: `cbd1ca1e57141617f5434bd8137d9758f046a61e` (2026-11-07), for
every area.

## What is here

| Directory                                                | Files | What                                                                                                                                                                                                |
| -------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources/`                                             | 6     | `testharness.js`, `testdriver.js`, `webidl2/lib/webidl2.js` (served as `/resources/WebIDLParser.js`) and `blank.html` (upstream); `testharnessreport.js`, `testdriver-vendor.js` (ours, below)      |
| `common/`                                                | 19    | `get-host-info.sub.js`, `utils.js`, `gc.js`, `dispatcher/`, `subset-tests*.js`, `security-features/resources/common.sub.js` and the small files the tests load                                      |
| `images/`, `media/`, `interfaces/`, `service-workers/`   | 10    | the images and media the tests load, `html.idl`, the `test-helpers.sub.js` the workers data: URL tests borrow                                                                                       |
| `cookies/`                                               | 85    | attributes, encoding, name, ordering, path, prefix, size, value, the http `secure/` tests, the top-level ones (`wpt-cookies`); `samesite/`, `samesite-none-secure/`, `domain/` (`wpt-cookies-more`) |
| `fetch/metadata/`                                        | 35    | the generated `*.https.sub.html` matrix, `fetch.https.sub.any.js`, `fetch-preflight.https.sub.any.js`                                                                                               |
| `fetch/api/`                                             | 169   | `basic/`, `cors/`, `credentials/`, `redirect/`, `headers/`, `request/`, `response/`, `abort/` and their `resources/`                                                                                |
| `referrer-policy/generic/`                               | 51    | the hand-written tests (inheritance, subresource-test, resources)                                                                                                                                   |
| `referrer-policy/gen/`                                   | 310   | `top.http-rp`, `top.meta` and `req.attr`, `.http.html` sources, nine subresource kinds                                                                                                              |
| `xhr/`                                                   | 367   | every top-level test but the ones below, `formdata/`, `resources/` (the files the tests load; the python handlers are ported)                                                                       |
| `eventsource/`                                           | 87    | every test of the directory, the hand-written `dedicated-worker/` and `shared-worker/` pages, `resources/`                                                                                          |
| `beacon/`                                                | 17    | `beacon-{basic,cors,navigate,redirect}.https.window.js`, `beacon-url-encoding-euc-kr.https.html`, `headers/`                                                                                        |
| `websockets/`                                            | 187   | the top-level tests, `binary/`, `closing-handshake/`, `constructor/`, `interfaces/`, `keeping-connection-open/`, `multi-globals/`, `opening-handshake/`, `security/`                                |
| `workers/`                                               | 514   | the top-level tests, `constructors/`, `baseurl/`, `multi-globals/`, `interfaces/`, `semantics/`, `modules/`, `support/`, `resources/`                                                               |
| `webstorage/`                                            | 72    | the top-level localStorage and sessionStorage tests and `resources/*.html`                                                                                                                          |
| `IndexedDB/`                                             | 111   | 97 `.any.js` basics named in `lists/indexeddb.mjs`, nine cross-realm and origin pages, their resources                                                                                              |
| `url/`                                                   | 42    | every test but idlharness, with `resources/*.json`                                                                                                                                                  |
| `encoding/`                                              | 116   | the `.any.js` API tests and `streams/`; the document tests (BOM, meta, header, utf-32, unsupported labels); a bounded sample of `legacy-mb-*`                                                       |
| `content-security-policy/`                               | 83    | connect-src, form-action, frame-src and navigation (javascript: URLs), with their support files                                                                                                     |
| `html/browsers/history/the-history-interface/`           | 103   | pushState, replaceState, back, forward and go, traversal, joint session history                                                                                                                     |
| `html/browsers/history/the-location-interface/`          | 97    | the Location setters, assign, replace, reload, ancestorOrigins, the cross-origin checks                                                                                                             |
| `html/browsers/windows/`                                 | 101   | nested browsing contexts, browsing context names, opener, frameElement                                                                                                                              |
| `html/semantics/scripting-1/the-script-element/`         | 595   | the directory's tests, `fetch-src/`, `microtasks/`, `execution-timing/`, `module/`                                                                                                                  |
| `html/webappapis/dynamic-markup-insertion/`              | 132   | document-write, document-writeln, closing-the-input-stream                                                                                                                                          |
| `html/webappapis/scripting/events/`                      | 55    | event handler attributes, onerror, the body and window forwarding                                                                                                                                   |
| `html/infrastructure/urls/dynamic-changes-to-base-urls/` | 2     | what a changed `<base href>` does to element URLs                                                                                                                                                   |
| `dom/nodes/`                                             | 92    | insertion, removal, cloning, textContent, the attribute setters, MutationObserver                                                                                                                   |

`test/wpt-server.mjs` serves the tree at the WPT paths the tests hard-code and
ports what wptserve would do: `.sub.` template substitutions (`{{host}}` is
`localhost`, the same-site hosts `www.localhost`, the cross-site hosts
`127.0.0.1`, every port the fixture's, `https` collapsed to `http`: localhost
is a secure context, so the trustworthy-origin cases keep their meaning;
Chrome treats `www.localhost` as cross-site to `localhost`, so the same-site
cases fail natively and drop out of the comparison),
`.headers` sidecars, `.any.html` / `.window.html` wrappers, and the python
handlers the vendored tests call (`cookies/resources/{cookie,set-cookie,set,
drop,list,echo-json}.py`, `fetch/metadata/resources/{record-headers,
echo-as-json}.py`, `fetch/api/resources/redirect.py`,
`common/security-features/subresource/{xhr,document,script,worker,image,
empty,static-import}.py` with the redirection and stash actions,
`referrer-policy/generic/resources/{referrer,refresh-policy}.py`). Every later
area ports the handlers its tests call in `test/wpt-handlers/<area>.mjs`; its
section below names them.

Ours, not upstream:

- `resources/testharnessreport.js` doubles the harness timeout (the proxied
  path is slower; the native run gets the same budget) and posts each page's
  results to `/_wpt/report` on the page's own origin, whatever its base URL
  became, keeping a copy on `window.__wptResults`. The report names the page
  by the path and query it was loaded from, with the query's escapes undone:
  a page that moves itself with pushState or replaceState still reports under
  its own path, and a variant written with a space is the variant the runner
  asked for. It sends no keepalive request (Chrome sends those past the
  service worker, so through the proxy the report would never arrive).
- `resources/testdriver-vendor.js` has no WebDriver: `delete_all_cookies`
  expires what `document.cookie` can see (own path, ancestors, root; a
  nameless cookie with a placeholder value, since `=` alone is ignored) and
  settles in a later task like WebDriver, spreading its writes over tasks
  (each proxied `document.cookie` write is a beacon, and Chrome refuses a
  document's beacons past 64 KiB in flight), `click`
  is a synthetic click, so `test_driver.bless()` runs its action without user
  activation and the "user activated" cases fail natively instead of waiting.

The runner keys a page's subtests by a stable name (`stable` in
`test/wpt.mjs`): a port in a name or a message is written `:PORT` and a uuid
`UUID`, since both change from run to run and some tests name a subtest after
a URL. The fixture reads a report's body as one UTF-8 stream, so a non-ASCII
subtest name split between two chunks stays one name (a report of thousands
of them, `encoding/legacy-mb-*` or `url/`, otherwise lost one at random and
showed it MISSING). With these in the harness no area patches the report
script for its own pages, and a handler module needs no patch to take a port
out of a subtest name.

## What was left out, and why

For the first three areas (each later area's section below has its own):

- `cookies/samesite*`, `cookies/domain` are the `wpt-cookies-more` suite;
  `cookies/schemeful-same-site`, `cookies/partitioned-cookies`,
  `cookies/third-party-cookies`, `cookies/origin-bound-cookies`: need https,
  several registrable domains or ports.
- `cookies/secure/*.https.*` and `set-from-ws(s)`: a secure page or a
  WebSocket that sets cookies (the proxy does not apply WebSocket
  `Set-Cookie` by design).
- `*.https.html` / `*.https.window.js` under the directories of
  `wpt-cookies`: tests that must fail over http.
- `fetch/metadata/generated/{serviceworker,fetch-via-serviceworker,
audioworklet}`: a service worker or a worklet behind the request.
- `fetch/metadata/generated/{element-link-prefetch,element-meta-refresh,
header-refresh}` (optional, seconds per case) and `header-link` (needs
  `header-link.py`).
- `fetch/metadata/*.html` top-level tests and `redirect/`: `record-header.py`
  with media payloads, `trailing-dot` hosts, CSP reports.
- `referrer-policy/gen/{iframe,srcdoc,srcdoc-inherit,iframe-inherit,
iframe-data-inherit,worker-classic,worker-module}.*` and every
  `.https.html`: 7 MB more of the same matrix; the top-level and attribute
  deliveries already exercise each proxy code path (document header, meta
  tag, element attribute, each subresource kind).
- `referrer-policy/gen/*/{sharedworker-*,svg-a-tag,mathml-a-tag}`: more pages
  without another proxy path.
- `referrer-policy/4K*`: the 4 KiB Referer boundary needs `history.pushState`
  to a long URL on the top-level page.
- `referrer-policy/generic/iframe-upgrade-request-to-*`: upgrade-insecure
  requests need an https origin.
- `referrer-policy/generic/inheritance/popup-*` and `workers.html`: popups
  without activation, a service worker.
- `mixed-content/`: nothing of it runs on the fixture. Every page is an
  `.https.` document loading an `http:` subresource, and Chrome restricts
  mixed content only in an `https:` document: with https collapsed to http
  there is no secure document, and every host of the fixture is a
  trustworthy origin whose loads are never mixed. It needs a real https
  origin beside an http one on a host that is not loopback, which is what the
  `mixed-content` suite builds with `test/mixed-servers.mjs`; the WPT matrix
  (`top.meta/unset` and `opt-in`, about 120 pages for the top-level
  deliveries) could run on that.

## XHTML scripts

An XHTML (or SVG) document is re-created through the hooks, so none of its
scripts is the parser's. Its external scripts keep their document order (a
script that never asked for `async` is marked `async = false`), but an inline
script runs before an external script ahead of it has loaded, where the XML
parser would have waited for it. A page that loads `testharness.js` and then
calls `test()` from an inline script reports nothing, or reports only when
the library happened to arrive first. `wpt-script-element` skips
`script-type-and-language-js-xhtml.xhtml` (457 subtests) because its proxied
verdict flips between runs for that reason; the other XHTML pages time out or
fail the same way every run, so they stay listed (`wpt-script-element`,
`wpt-script-timing`, `wpt-document-write`, `wpt-modules`, `wpt-base-urls`,
`BACKLOG.md`) until the re-created document waits for each external script as
the parser does.

## The areas

### fetch/api

Suites `wpt-fetch-basic` (`basic/`), `wpt-fetch-cors` (`cors/`),
`wpt-fetch-credentials-redirect` (`credentials/`, `redirect/`),
`wpt-fetch-objects` (`headers/`, `request/`, `response/`) and
`wpt-fetch-abort` (`abort/`). Every `.any.js` runs in a page and in a
dedicated worker: 279 pages (64, 46, 30, 132, 7). `wpt-fetch-cors` and
`wpt-fetch-credentials-redirect` run one page at a time:
`credentials/cookies.any.js` and the cors cookie pages share the jar (with
four pages at once the native verdicts of `cookies.any.js` flip). Also
vendored for them: `xhr/resources/` (the six `.asis` responses of
header-value-combining), `utf16-bom.json`, `images/blue.png`,
`common/gc.js`.

Handlers (`test/wpt-handlers/fetch-api.mjs`): `fetch/api/resources/
{inspect-headers,redirect,preflight,clean-stash,method,status,echo-content,
trickle,authentication,dump-authorization-header,cache,bad-chunk-encoding,
infinite-slow-response,stash-put,stash-take,stashed-chunk,
preflight-unterminated-body,script-with-header,redirect-empty-location,
echo-header-bytes}.py`, `fetch/api/request/resources/cache.py`,
`xhr/resources/{status,echo-headers,parse-headers,content-in-chunks}.py`,
`common/redirect.py`, and the request and connection counting of
`fetch/connection-pool/resources/network-partition-key.py`. Query and header
values are byte strings (latin1), as wptserve hands them to python; the stash
is per path, as wptserve's is; this `redirect.py` replaces the short one in
`test/wpt-server.mjs` (the Location carries the request's parameters and
`&count=N`); `status.py`, `echo-headers.py`, `bad-chunk-encoding.py` and
`content-in-chunks.py` write to the socket (a reason phrase of the test's, a
body after a 204, chunk framing broken on purpose).

Stand-ins for what the fixture has not:

- A second http port: `integrity.sub.any.js`, `mode-no-cors.sub.any.js`,
  `cors-expose-star.sub.any.js`, `cors-filtering.sub.any.js`,
  `cors-multiple-origins.sub.any.js` are served with
  `http://{{host}}:{{ports[http][1]}}` as `http://www2.localhost:<port>`, and
  eight `cors/*.any.js` files with `HTTP_ORIGIN_WITH_DIFFERENT_PORT` as
  `OTHER_ORIGIN` (the same host). The subtest names still say "different
  port".
- https: `credentials/authentication-redirection.any.js` runs with
  `HTTPS_REMOTE_ORIGIN` and `HTTPS_ORIGIN` as their http twins (a same-origin
  and a cross-origin redirect, which is what it is about).

Left out: the `*.h2.*` tests (HTTP/2 handlers);
`basic/request-upload-421.any.js` (wptserve behind a PAC proxy); the tests
with a service worker behind the request
(`abort/serviceworker-intercepted.https.html`,
`request/request-reset-attributes.https.html`, `request/destination/`); the
keepalive tests and their resources (requests that outlive their document,
three seconds of waiting per case; worth a suite of its own, since Chrome
hands no keepalive request to a service worker);
`basic/fetch-in-popup-from-iframe.html` (a popup without user activation).

Fails natively on the fixture, so not compared: Chrome's own failures (the
same on wpt.fyi: `basic/response-null-body`, `redirect/redirect-empty-location`,
`response/response-error-from-stream`, `response/response-stream-disturbed-by-pipe`,
eight of `abort/general` and a handful elsewhere); the "different protocol"
cases and the opaque-response cases of `integrity.sub` and `mode-no-cors.sub`,
which have no stand-in (`mode-no-cors.sub` also reports a duplicate test name,
so its harness status is ERROR natively); `cors-cookies` and
`cors-cookies-redirect`, whose two hosts are one site upstream and two on the
fixture; the unknown methods and control characters in header values that
Node's HTTP parser refuses (`request-headers`, `cors-preflight`,
`cors-preflight-star`, `redirect-method`, `header-values-normalize`,
`header-values`, `cors-preflight-not-cors-safelisted`); one case of
`cors-expose-star.sub` (the fixture's `text/plain; charset=utf-8` for `.txt`).
Chrome 156 passes 18 more abort and 4 more objects subtests natively than
152, and all of them pass through the proxy, so the lists are the same on
both.

Skipped: nothing.

### xhr

Suites `wpt-xhr-cors` (89 pages), `wpt-xhr-events` (100), `wpt-xhr-timeout`
(30), `wpt-xhr-request` (125) and `wpt-xhr-response` (75), split by
`groupOf` in `lists/xhr.mjs` (a page belongs to the first group its path
matches), in a window and a dedicated worker. Also vendored for them:
`fetch/api/resources/utils.js`,
`html/dom/documents/resource-metadata-management/support/document-lastModified-utils.js`,
`images/100px-green-rect.svg`, `media/1x1-green.png`. Chrome 156 passes 15
more subtests natively than 152 (13 of `blob-range.any.worker`, 2 of
`responseXML-xml-scripting-support-disabled`); they fail proxied, so they are
listed.

Handlers (`test/wpt-handlers/xhr.mjs`): the python handlers under
`xhr/resources/` the kept tests call (access-control-\*, auth\*/, echo-\*,
inspect-headers, status, redirect, delay, trickle, chunked, gzip, zlib,
content, conditional, upload, the charset pages and more),
`fetch/api/resources/dump-authorization-header.py`, `bad-chunk-encoding.py`;
`resources/over-1-meg.txt` is written by the module instead of vendored.

Left out: `idlharness.any.js`; `status.h2.window.js` (HTTP/2); the
`*-manual.htm` pages;
`xmlhttprequest-sync-default-permissions-policy.tentative.sub.html` (the
permissions-policy helpers, an https frame); `security-consideration.sub.html`
and `resources/img.jpg` (a second port that refuses the request);
`send-conditional-cors.htm` (`/cors/support.js`).

Fails natively on the fixture (120 subtests): custom methods Node's HTTP
parser answers with a 400 (status-async, status-basic,
open-method-case-sensitive, send-redirect-to-cors, send-redirect,
preflight-cache-invalidation-by-method); `charset=utf-8` on static files where
wptserve sends none (open-url-encoding, cors-expose-star, the "contentType"
case of responsexml-document-properties); the simplified
`fetch/api/resources/redirect.py` (the third subtest of
xhr-authorization-redirect); files the checkout lacks (the generated subtests
of overridemimetype-blob, two of formdata.html).

Skipped (`skipped` in `lists/xhr.mjs`, besides every page of another group):

- `open-url-multi-window-4.htm`, `timeout-multiple-fetches.html`: time out
  natively, 20 s each (Chrome fires no error event for a request whose frame
  is removed; the preflight delay outlasts the harness).
- `xmlhttprequest-timeout-worker-aborted.html`,
  `xmlhttprequest-timeout-worker-overridesexpires.html`: 22 s a variant in
  each mode, since the worker runs every case of the file for each variant;
  the -simple, -twice, -overrides and -synconworker files measure the
  worker's timeouts.
- `access-control-basic-allow-preflight-cache-timeout.any.*`: its proxied
  verdict flips between runs in both globals (some runs the second PUT reads
  the first one's answer; `BACKLOG.md`, `wpt-xhr-cors`).
- the "load fires normally with same timeout set twice" variant of
  `xmlhttprequest-timeout-twice.html` and `-worker-twice.html`: natively
  flaky under load (the load comes after 4 s against a 5 s timeout; the
  native verdict flipped in 2 of 5 runs on a loaded machine).

### eventsource

Suites `wpt-eventsource` (everything but `format-*`: 55 pages, in a window, a
dedicated worker and a shared worker) and `wpt-eventsource-format`
(`format-*`: 52 pages, in a window and a dedicated worker), split to stay
near two minutes each. Both run one page at a time: the reconnection tests
keep their state in cookies, and every page starts by emptying the jar.
Nothing of the directory is left out but `META.yml`, `README.md`,
`WEB_FEATURES.yml` and the python handlers.

Handlers (`test/wpt-handlers/eventsource.mjs`): `eventsource/resources/
{message,message2,last-event-id,last-event-id2,status-error,status-reconnect,
reconnect-fail,cors,cors-cookie}.py`, the `.event_stream` files (served as
`text/event-stream` with `?pipe=sub` by a `patterns` entry),
`common/redirect.py`, `xhr/resources/content-in-chunks.py`. Query values
are decoded to bytes as wptserve does (`message=%FF%FE...`, an id with NUL).

Stand-in: a cookie set on a cross-origin request carries
`SameSite=None; Secure`. The tests' other origins (`www2.localhost`,
`xn--lve-6lad.localhost`) are same-site with the page on wptserve's domain
and cross-site on the fixture; without it the credentialed cases would fail
natively for a reason that is not EventSource's.

Fails natively: "constructor (invalid URL)" of
`eventsource-constructor-url-bogus.any.js` in all three globals (Chrome
accepts `http://this is invalid/`); `format-utf-8.any.js` in both globals
(Chrome refuses an event stream whose Content-Type names a charset other than
UTF-8).

Skipped: each suite skips the other's pages, nothing else.

### beacon

Suite `wpt-beacon`: 15 pages, one page at a time (the quota of beacons in
flight is the document's, and the proxy's own synchronous requests share
it). Also vendored for it: `common/text-plain.txt`. Left out:
`beacon/idlharness.any.js`.

Handlers (`test/wpt-handlers/beacon.mjs`): `beacon/resources/{beacon,
content-type-and-body,inspect-header,url-echo}.py` (beacon.py with its
payload check and a small multipart reader for the FormData payload),
`common/redirect.py`, and upstream's full `fetch/api/resources/redirect.py`
served as `/beacon/resources/fetch-redirect.py` (the fixture's handler of
that name is the short one the fetch-metadata tests use).

Stand-ins, as served (`patches` in the module; the vendored files are
upstream's bytes): `beacon-cors.https.window.js` gets get_host_info()'s
`HTTP_REMOTE_ORIGIN` for `HTTPS_REMOTE_ORIGIN` and the private
`fetch-redirect.py`; the four `headers/header-referrer-*.https.html` pages
(no-referrer-when-downgrade, strict-origin, strict-origin-when-cross-origin,
unsafe-url) get the http origin for the https one, and their second half (a
beacon from the https page down to an http origin) is taken out: there is no
downgrade to make on the fixture, and left in it repeats the first half's
subtest name, which the harness reports as an error of the page.

Fails natively: the two cases to another origin of
`headers/header-origin-same-origin.html` (the test wants `Origin: null`,
Chrome sends the page's origin).

Skipped: nothing.

### websockets

Suite `wpt-websockets`: window and dedicated worker, the `?default` (ws:)
variant only, 188 pages. Also vendored for it: `common/gc.js`.

Handlers (`test/wpt-handlers/websockets.mjs`): the pywebsocket endpoints of
`websockets/handlers/` (each `<name>_wsh.py` served as `/<name>` on the
fixture's port with the `ws` package: 23 endpoints, among them echo,
echo-query, empty-message, origin, referrer, protocol, the handshake ones,
basic_auth, the close ones, invalid, wrong_accept_key), keeping pywebsocket's
behaviour around a handler (close 1000 on return, permessage-deflate unless
turned off, no subprotocol unless picked), and
`opening-handshake/resources/redirect_response.py`, `security/check.py`. One
difference from pywebsocket: every endpoint answers a client's Close with
its own code and reason.

Left out: `idlharness.any.js`; the back/forward cache tests (the
remote-context helper and a stash); `mixed-content.https.any.js`;
`remove-own-iframe-during-onerror.window.js` (fetch stash handlers);
`constructor/target-address-space.any.js` (a local-network access prompt);
`send-many-64K-messages-with-backpressure.any.js` (megabyte messages, a
sleeping reader).

Fails natively: 16 subtests, mostly the ones that need a second port, https
or a server behaviour the fixture lacks.

Skipped (`test/suites/wpt-websockets.mjs`):

- the `?wss` and `?wpt_flags=h2` variants: the fixture speaks neither TLS nor
  HTTP/2.
- `keeping-connection-open/`: 20 s on an idle socket, past the harness
  natively.

The pages that wait for a message the server sends in answer to one send
(Send-\*, `binary/`, Close-server-initiated-close, `closing-handshake/`,
`events/015` to `018`, `send/006` to `011`, `security/001`,
send-data-isolation and others) run: epoxy-transport hands an incoming
frame to the page as it arrives since its 0061 patch (deploy/epoxy). Before
it, epoxy held each incoming frame until the next outgoing one was written,
and those pages timed out or passed by a race, so they were skipped. The
ten of them that still fail are listed, each for its own reason (BACKLOG,
wpt-websockets).

### workers, webstorage, IndexedDB

Suites, all one page at a time (shared workers are found by script URL and
name across the browser's pages, and storage is one store per origin):

- `wpt-workers-basics`: the top-level `workers/*` tests but the scope ones
  (79 pages).
- `wpt-workers-constructors`: `constructors/`, `baseurl/`, `multi-globals/`
  (43 pages).
- `wpt-workers-scope`: the top-level WorkerLocation, WorkerNavigator,
  WorkerGlobalScope and importscripts\_ tests and `interfaces/` without
  WorkerUtils (78 pages).
- `wpt-workers-semantics`: `interfaces/WorkerUtils/` and `semantics/` (68
  pages).
- `wpt-workers-modules`: `modules/` (27 pages).
- `wpt-webstorage`: 46 pages.
- `wpt-indexeddb`: 199 pages.

The workers suites run in a window, a dedicated and a shared worker;
IndexedDB in a window and a dedicated worker. Also vendored for them:
`common/dispatcher/` and
`service-workers/service-worker/resources/test-helpers.sub.js`, which the
workers data: URL context tests borrow.

Handlers (`test/wpt-handlers/workers.mjs`): `common/redirect.py`,
`workers/modules/resources/redirect.py`, the baseurl `beta/*.py` redirects,
`WorkerGlobalScope/location/helper-redirect.py`,
`service-workers/service-worker/resources/redirect.py`,
`modules/resources/{export-on-load-script,export-credentials,
postmessage-credentials,export-referrer-checker,
postmessage-referrer-checker}.py`, `semantics/encodings/003-1.py`,
`support/imported_script.py`, `support/nosiniff-error-worker.py`. webstorage
and IndexedDB need none.

Stand-ins: a `patterns` entry serves `worker-url-encoding.html` without the
fixture's `charset=utf-8` (wptserve sends none, and the page's own
windows-1252 is what it tests); a `patches` entry gives
`WorkerLocation-origin.sub.window.js` wptserve's punycode name for the IDN
host.

Left out:

- `workers/SharedWorker-extendedLifetime*`: an origin trial behind a flag.
- `workers/shared-worker-partitioned*` and their support files: third-party
  partitioning over several https sites.
- the two ImageData structured-clone pages of
  `DedicatedWorkerGlobalScope/postMessage/`: nothing a proxy stands in.
- `workers/postMessage_block.https.html`: spins the main thread on a
  SharedArrayBuffer; natively it never ends, and the runner's tab cannot be
  navigated away.
- `workers/SharedWorker_dataUrl.html`,
  `shared-worker-runtime-error-is-not-parse-error.html`: time out natively.
- `workers/semantics/{interface-objects,structured-clone}/`: interface
  listings and clone matrices, no proxy path.
- `workers/{examples,non-automated,same-site-cookies}/`: examples, manual
  tests, and SameSite cookies of workers across https sites (the cookie
  suites cover the jar).
- `IndexedDB/`: everything not named in `lists/indexeddb.mjs` (the large
  generated and the storage-pressure tests). `webstorage/`: nothing below
  the top level but `resources/*.html`.
- `service-workers/`: not measured. A page's own service worker under a
  service-worker proxy is a known architecture limit (one worker per scope,
  and the scope is the proxy's).

Fails natively: in webstorage, `set.window.html` (12, "with data/accessor
property on prototype": Chrome lets the item win), `storage_builtins.window.html`
(2), `storage_session_window_reopen.window.html` (1); in IndexedDB, "a
self-referential array exhausts the stack" of `keypath.any.js` in both
globals (Chrome 152 does not throw); in workers,
`semantics/encodings/001.html` and `002.html` (a worker script served as
windows-1252), among others.

Skipped:

- `wpt-workers-basics`: the directories below `workers/` and the scope tests
  (the other suites), and `abrupt-completion.html`, natively flaky (its
  shared worker subtest passes in a full run and fails when the page runs
  alone, three of three).
- `wpt-workers-scope`: every top-level test not named for the scope, every
  directory but `interfaces/`, and `interfaces/WorkerUtils/` (the other
  suites).
- `wpt-webstorage`: `storage_{local,session}_setitem_quotaexceedederr` and
  `storage_{local,session}_quota_independent_from_{session,local}`. Each
  fills a store 1 KiB at a time until setItem throws (the quota_independent
  ones again after a `clear()`); through the proxy each write is a
  synchronous beacon to the worker, and the proxied tab crashes before the
  quota is reached, taking every later page of the run with it.

### url

Suites `wpt-url` (the `.any.js` tests in a window and a dedicated worker:
URL, URLSearchParams, the IDNA tables; 56 pages, about 7,050 subtests) and
`wpt-url-elements` (the `.html`, `.xhtml` and `.window.js` tests: anchors,
areas and `<base>`, `failure.html`, percent-encoding, javascript: URLs; 19
pages, 5,212 subtests). Also vendored: `common/subset-tests-by-key.js`.
Handlers (`test/wpt-handlers/url.mjs`): `url/resources/percent-encoding.py`.

Left out: `url/idlharness.any.js` (it needs `/resources/WebIDLParser.js`,
which `refresh.mjs` could not vendor while it could not wipe a directory
under `resources/`; it can now, and the html areas vendor the parser, so the
page can come back; measured once, 77 subtests per global, no proxied
failure); the shared worker and service worker globals of the `.any.js`
tests (the same script a third and a fourth time).

Fails natively: about 700 subtests, the IDNA and file: cases on which the URL
standard and Chrome disagree.

Skipped: each suite skips the other's pages, nothing else.

### encoding

Suites `wpt-encoding-api` (TextDecoder, TextEncoder, TextDecoderStream,
TextEncoderStream in a window and a dedicated worker: 95 pages, about 23,900
subtests) and `wpt-encoding-legacy` (documents whose own encoding matters: 27
pages, 5,345 subtests).

Handlers (`test/wpt-handlers/encoding.mjs`): `encoding/resources/
{single-byte-raw,text-plain-charset,text-html-meta-charset,json-charset}.py`.
The module also serves every file of `encoding/` itself, typed as wptserve
types it (`text/html` and `application/xml` without a charset parameter, a
`.headers` sidecar's Content-Type instead of the guess): `wpt-server.mjs`
adds `charset=utf-8` to html, which would decide the very thing these pages
test.

Left out:

- the `legacy-mb-*` pages under an alias label (`sjis_chars-ms932.html` and
  the like): the same bytes again, 370 to 850 KiB each. Kept: one
  whole-index decode page for shift_jis, iso-2022-jp and big5, the
  decode-errors page of each of the five encodings, and of the encode pages
  (what a link and a form encode) only euc-kr's.
- `encoding/idlharness.any.js`: as for url. `encoding/eof-*.html`: reference
  tests. `sharedarraybuffer.https.html`: SharedArrayBuffer behind isolation
  headers.

Skipped:

- `wpt-encoding-api`: the document pages (the other suite) and
  `encodeInto-tail-unmodified.any.js`, which natively runs past the harness
  timeout (41 s) and held a proxied worker for almost six minutes.
- `wpt-encoding-legacy`: the API pages (the other suite); of each
  whole-index decode page, every variant but its first and last thousand
  pointers; of each encode page, every variant but its last, short one. The
  proxy serves every document as UTF-8 and so encodes a query as UTF-8 too,
  so each subtest of the encode pages is one more entry from one cause
  (41,332 entries when they all ran at `?1-1000`); they come back when the
  document's encoding is carried through.

### content-security-policy

Suite `wpt-csp`: connect-src, form-action, frame-src and navigation
(javascript: URLs), 56 pages, two at a time. The proxy enforces a page's
policy itself (the browser sees every proxied URL as the proxy's own
origin), so each page measures the inject's or the worker's answer against
Chrome's. Also vendored: `common/dummy.json`, `common/text-plain.txt`.

Handlers (`test/wpt-handlers/csp.mjs`): `common/redirect.py` (with
`enable-cors`), `content-security-policy/support/echo-policy.py`, wptserve's
`/echo` WebSocket, and the extensionless
`connect-src/resources/simple-event-stream` typed `text/event-stream`.

Left out: every `.https.` page (a real https origin, WebTransport,
worklets); `navigation/javascript-url-navigation-to-*-evaluated-to-string-inherits-csp.html`
and the two support pages with a `report-uri` (they read a report's delivery
back from `/reporting/resources/report.py`, a stash server);
`frame-src/frame-src-cross-origin-same-document-navigation.window.js`
(drives a frame of another host through `/common/dispatcher/`); the other
directories (script-src, style-src, img-src and the rest), out of the bound,
and script-src and style-src overlap the `csp-scripts` and `csp-navigation`
suites.

Fails natively: 6 subtests.

Skipped: `connect-src/connect-src-text-import-*` (Chrome 152 has no text
module imports: natively FAIL and TIMEOUT) and `frame-src/frame-src-redirect.html`
(natively its one subtest times out). Two of them take the whole budget, for
nothing compared.

### cookies, the second suite

Suite `wpt-cookies-more`: `samesite/` (fetch, frames, forms, images, popups,
about:blank, sandboxed frames, Set-Cookie from navigations),
`samesite-none-secure/`, `domain/`; 25 pages, one at a time (they share the
jar). The proxy computes each of these itself: to the browser every proxied
request is same-site. `wpt-cookies` skips these three directories.

These pages are `.https.` upstream because SameSite=None needs Secure; on
the fixture localhost is a secure context, so they run over http:
`refresh.mjs`'s `cookies/.*\.https\.` exclude covers only the first suite's
directories, and `test/wpt-handlers/cookies-more.mjs` serves this suite's
pages an http copy of `cookies/resources/cookie-helper.sub.js`
(`/cookies/resources/cookie-helper-http.sub.js`, its `"https://" + HOST`
origins made `http://`). The first suite's pages keep the original file.

Handlers: `cookies/resources/{setSameSite,setSameSiteDomain,dropSameSite,
setSameSiteNone,dropSameSiteNone,setSameSiteMultiAttribute,
dropSameSiteMultiAttribute,setSecure,dropSecure,postToParent,
redirectWithCORSHeaders,imgIfMatch,list-cookies-for-script}.py`, and the
navigate-after-set pages of `cookies/resources/`.

Left out: `samesite/get_all_cookies-default-samesite.html` and
`get_named_cookie-default-samesite.html` (they ask WebDriver for the jar,
which the vendored testdriver has not); `domain/domain-attribute-idn-host.*`
(an IDN host set up by a python handler).

Fails natively: the `Subdomain` and www cases (www.localhost is cross-site to
Chrome on the fixture) and several redirect cases, about 51 subtests. The
`*-reload` pages (form-get-blank-reload, form-post-blank-reload,
window-open-reload) end natively in a harness TIMEOUT with some subtests
passing, 20 s per mode.

Skipped: `samesite/iframe-reload.https.html`, which natively posts no report
within the budget (two recorded runs): 30 s in each mode for nothing
compared.

### html and dom

The html and dom areas share `test/wpt-handlers/html.mjs`: it ports
`common/redirect.py` (and `module/dynamic-import/beta/redirect.py`),
`common/slow.py`, `xhr/resources/delay.py`,
`windows/resources/window-name-stash.py`, `log.py`, `module-fetch-tester.py`,
`serve-custom-response.py`, `serve-with-content-type.py`,
`resources/cross-origin.py`, `resources/load-error-events.py`,
`module/resources/check-cookie.py` and `module/resources/referrer-checker.py`,
and serves the IDL parser at wptserve's name. Their lists are
`lists/html-history.mjs`, `html-windows.mjs`, `html-scripting.mjs`,
`html-events.mjs` and `dom-insertion.mjs`.

Left out of all of them: pages a human drives (`non-automated/`,
`*-manual.*`), print reference tests, crash tests, the window move event
tests (a window manager behind testdriver), the change-event removing-steps
test (a real pointer), and secure-context pages that must fail over http.
Of their suites only `wpt-script-element` skips pages (below).

#### history, location, windows

Suites `wpt-history` (65 pages), `wpt-location` (66) and `wpt-windows` (48),
two pages at a time; popups are the browser's (the runner's own controller,
below).

Left out: `history_(push|replace)state_too_many_calls*` (Chrome reaches no
rate limit in ten seconds) and `nested-browsing-contexts/frameElement-siblings.sub.html`
(a sibling frame on a second port; natively it times out); the
RemoteContextHelper windows (popups behind the dispatcher handler):
history-state-after-bfcache, history_go_zero_which_document, the windows
`auxiliary-browsing-contexts` named-lookup-\* and no-proactive-swap-\*,
`browsing-context-names/duplicate-name-order`; the `*.https.*` windows
pages.

Fails natively: in windows, `choose-_current-001.html` (Chrome 152 still
targets the current window for `_current`), `consume-user-activation/window-open.html`
(user activation), `document-domain-nested-navigate.window.html`
(document.domain is off in Chrome), the two subtests of
`embedded-opener-remove-frame.html`; in location,
`location-protocol-setter-sameish.html` (3: Chrome 152 throws for a tab or
LF in the scheme), `location-encoding-parse.html` (the fixture serves `.html`
as `charset=utf-8` where wptserve sends no charset, so its windows-1252 meta
loses) and `location-origin-idna.sub.window.js` (the server substitutes the
Unicode host where wptserve substitutes punycode). 001.html and 002.html of
history want a fresh tab natively ("make sure that you loaded the test in a
new tab"), which the native run gives.

#### the script element, modules, document.write

Suites `wpt-script-element` (the directory's own tests with `fetch-src/` and
`microtasks/`, 75 pages), `wpt-script-timing` (`execution-timing/`, 156),
`wpt-modules` (`module/`, 109) and `wpt-document-write`
(`dynamic-markup-insertion/`, 94).

Left out: `fetch-src/empty-set-while-connected.html` and
`execution-timing/102.html` (they time out natively); the `import defer`
tests (Chrome does not parse them); the modulepreload referrer tests (they
need `preload/resources/echo-referrer.py`).

Fails natively: in wpt-modules, the "beta - Function" and "gamma - Function"
cases of `dynamic-import/code-cache-base-url.html` (Chrome's own code-cache
bug, crbug 990810) and the one subtest of `module-in-xhtml.xhtml`.

Skipped: `wpt-script-element` skips `execution-timing/` and `module/` (the
other suites) and `script-type-and-language-js-xhtml.xhtml` ("XHTML
scripts" above).

Chrome 152 and 157 decode a module script by its Content-Type charset only
when that names windows-1252 (or latin1, iso-8859-1, us-ascii), else as
UTF-8 (measured); the script charset fix does the same, so the module
`charset-01` and `charset-03` pages are not listed.

#### event handlers

Suite `wpt-event-handlers`: `html/webappapis/scripting/events`, event
handler attributes (whose code the rewriter rewrites), onerror and the body
and window forwarding, in a window and a dedicated worker; 48 pages.

Fails natively: ten of the window forwarding subtests of
`event-handler-attributes-body-window.html` and eleven of
`-frameset-window.html`.

Skipped: `compile-event-handler-settings-objects.html`, whose proxied
failures differ from run to run (the harness times out with either of two
subtests failing): the popup it opens loses the listeners its opener set,
when its shell opens its document (BACKLOG).

#### base URLs

Suite `wpt-base-urls`: the two pages of
`html/infrastructure/urls/dynamic-changes-to-base-urls`, one at a time.

#### dom insertion

Suite `wpt-dom-insertion`: the `dom/nodes` tests of insertion, removal,
cloning, textContent, the attribute setters and MutationObserver, the part
the inject's insertion hooks can change; 83 pages.

Left out: the rest of `dom/nodes` (selectors, collections, character data)
and `Document-createElement-namespace.html`.

## State of the expected lists

Measured 2026-11-07 (same-origin mode). `expected/wpt-cookies.json` and
`expected/wpt-fetch-metadata.json` come from complete runs.
`expected/wpt-referrer-policy.json` was re-measured with `WPT_CONCURRENCY=1`,
twice, the two runs identical (276 pages, 2522 subtests, 87 proxied failures
listed). The earlier measurement under three concurrent controller pages
recorded stalls, not verdicts: epoxy loses one of two requests to the same
origin started in the same tick (README "Embedding"), so pages that reported
in a second alone timed out there. Twelve pages still time out with one page
at a time, the `inheritance/` ones for about:blank, `javascript:`, srcdoc,
data: and `document.write` children among them; those are proxy failures,
not load.

Since then the lists only shrink as fixes land; on 2026-11-08 they held 9
cookie and 12 referrer-policy entries, each with its cause in
`docs/scramjet-parity.md` (the WPT row of section 9).

Re-measured 2026-11-15, after the referrer, about:blank and popup fixes of
that day and with the proxied run on a controller of its own (no `onOpen`,
so `window.open` opens the browser's popup; `test/wpt.mjs`): the
referrer-policy list is empty, and what is left is

- `wpt-cookies`, `ordering/ordering.sub.html`, "Cookies with longer paths
  are listed before cookies with shorter paths" (1): the proxied
  `fetch('/cookies/resources/cookie.py?set=...&location=...')` of the popup
  fails ("Failed to fetch") where Chrome follows the redirect; the cause is
  not yet known. The page's other three subtests fail natively (a `domain`
  attribute of `localhost` is refused, and the browser keeps an older
  `testB`), so this one is the only comparison the page gives.
- `wpt-fetch-metadata`, `element-link-icon` (12): Chrome fetches no favicon
  for a document in an iframe, and every proxied page is in one, so the
  page's requests never happen (`docs/scramjet-parity.md`, Sec-Fetch row).
- `wpt-fetch-metadata`, `element-img-environment-change` (15): the page
  times out at its cross-site step. In a document no service worker
  controls, an image of another origin loads from a sealed copy held in
  the memory cache, and Chrome prefers a cached candidate of higher density
  (`AvoidDownloadIfHigherDensityResourceIsInCache`), so the environment
  change loads from the cache with no request and the page waits for an
  `error` that never comes. A limit of sealed copies.

The other 37 suites were added on 2026-11-15. All 40 lists were then
recorded on 2026-11-15 on the combined tree, on Chrome 152 with the proxied
run on the runner's own controller, and the entries that only Chrome 156 or
157 passes natively (native failures on 152, so not compared there) were
merged in; Chrome 157 agreed with the result. A page whose native verdict
changed between records is in its suite's `skip`. Pages run are those of the
Chrome 152 record. The lists were checked again on the series rebased onto
d600d112, on Chrome 157, and the entries that pass there left (BACKLOG.md
says which); the counts below are of that tree, its pages run those of
that Chrome 157 run:

| Suite                            | Pages run | Pages listed | Entries listed |
| -------------------------------- | --------- | ------------ | -------------- |
| `wpt-fetch-basic`                | 64        | 6            | 18             |
| `wpt-fetch-cors`                 | 46        | 2            | 2              |
| `wpt-fetch-credentials-redirect` | 30        | 2            | 10             |
| `wpt-fetch-objects`              | 132       | 0            | 0              |
| `wpt-fetch-abort`                | 7         | 2            | 6              |
| `wpt-fetch-metadata`             | 29        | 2            | 27             |
| `wpt-xhr-cors`                   | 89        | 6            | 14             |
| `wpt-xhr-events`                 | 100       | 32           | 37             |
| `wpt-xhr-timeout`                | 30        | 3            | 3              |
| `wpt-xhr-request`                | 125       | 25           | 90             |
| `wpt-xhr-response`               | 75        | 17           | 93             |
| `wpt-eventsource`                | 55        | 3            | 6              |
| `wpt-eventsource-format`         | 52        | 6            | 6              |
| `wpt-beacon`                     | 15        | 0            | 0              |
| `wpt-websockets`                 | 246       | 70           | 273            |
| `wpt-workers-basics`             | 79        | 8            | 15             |
| `wpt-workers-constructors`       | 43        | 0            | 0              |
| `wpt-workers-scope`              | 78        | 0            | 0              |
| `wpt-workers-semantics`          | 68        | 16           | 28             |
| `wpt-workers-modules`            | 27        | 6            | 50             |
| `wpt-webstorage`                 | 46        | 17           | 41             |
| `wpt-indexeddb`                  | 199       | 1            | 5              |
| `wpt-url`                        | 56        | 0            | 0              |
| `wpt-url-elements`               | 19        | 8            | 394            |
| `wpt-encoding-api`               | 94        | 2            | 12             |
| `wpt-encoding-legacy`            | 27        | 10           | 428            |
| `wpt-csp`                        | 53        | 6            | 25             |
| `wpt-cookies`                    | 29        | 1            | 1              |
| `wpt-cookies-more`               | 24        | 7            | 25             |
| `wpt-referrer-policy`            | 276       | 0            | 0              |
| `wpt-history`                    | 65        | 4            | 87             |
| `wpt-location`                   | 66        | 6            | 12             |
| `wpt-windows`                    | 48        | 3            | 3              |
| `wpt-script-element`             | 74        | 8            | 11             |
| `wpt-script-timing`              | 156       | 10           | 17             |
| `wpt-modules`                    | 109       | 16           | 25             |
| `wpt-document-write`             | 94        | 29           | 34             |
| `wpt-event-handlers`             | 47        | 0            | 0              |
| `wpt-base-urls`                  | 2         | 1            | 21             |
| `wpt-dom-insertion`              | 83        | 2            | 3              |

`BACKLOG.md` has every listed entry with its suspected cause, and per suite
the entries the streams listed that this record no longer has.

## Running and refreshing

```sh
npm test -- wpt-cookies wpt-fetch-metadata wpt-referrer-policy
npm test -- wpt-xhr-request wpt-url-elements
UPDATE_EXPECTED=1 npm test -- wpt-cookies   # rewrite expected/wpt-cookies.json
```

The suites are gates, run by CI like any other (test/run.mjs; until
2026-11-18 they were measurements that `SKIP_MEASUREMENT=1` left out). A page
whose verdict flips from run to run is left out by its suite's `skip`, with
the reason in `BACKLOG.md`. A proxied failure not on the list fails the suite; so does a listed
failure that now passes, so a fix comes with its expected list trimmed.
Every page starts with an empty cookie jar in both modes and has 30 s to
report; a page that does not is a failure with the cause `timeout`. The
fixture of a `wpt-*` suite keeps idle connections for ten minutes: epoxy
hangs on a pooled connection the server closed (CHANGELOG known
limitations), which stalled whichever page came after a slow one.
`WPT_ONLY=<regex>` runs a few pages for a look, `WPT_CONCURRENCY=<n>` sets how
many load at once (the suites whose pages share the jar, the stores of an
origin or a shared worker run one at a time). The proxied run uses a
controller of its own on the demo's worker, without `onOpen`, so a page's
popup is the browser's. The runner gives `wpt-referrer-policy` 25 minutes
instead of the usual ten (the matrix at `WPT_CONCURRENCY=1`, the honest
setting, takes about sixteen; a run the runner kills writes no list);
`SUITE_TIMEOUT=<minutes>` overrides it for every suite of a run.

To refresh from upstream:

```sh
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/web-platform-tests/wpt /tmp/wpt
git -C /tmp/wpt sparse-checkout set $(node test/wpt/refresh.mjs --sparse)
node test/wpt/refresh.mjs /tmp/wpt
```

`refresh.mjs` holds the include and exclude lists of the first three areas
and reads every other area's from `lists/`, copies the files (the checkout
is data: nothing in it runs) and prints the upstream commit to put in this
file. Then rerun the `wpt-*` suites with `UPDATE_EXPECTED=1` and review the
diff of `expected/`.

## Adding an area

An area beyond the first three keeps its upstream directories and its
include and exclude lists in `lists/<area>.mjs` (exports `sparse`,
`include`, `exclude`, read by `refresh.mjs`), and the python handlers its
kept tests need, ported, in `test/wpt-handlers/<area>.mjs` (its default
export receives the server's tools and returns `handlers`, `patterns`,
`upgrades` and `patches`; see the comment above `handlerDir` in
`test/wpt-server.mjs`). The server ports what wptserve does for every area:
`.sub.` substitutions, `.headers` sidecars, the `.any.js`, `.window.js` and
`.worker.js` wrappers, `?pipe=` and `.asis` files. A suite is
`runWpt('wpt-<area>', { roots, concurrency, globals, skip, budget })` from
`test/wpt.mjs`: `globals` adds the worker variants of `.any.js` tests,
`skip` leaves pages out by path and query, `budget` is a page's time to
report in ms. The proxied run uses a controller of its own on the demo's
worker, without `onOpen`, so a page's popup is the browser's. Give the area a
section in this file (what its handlers port, its stand-ins, what was left
out and why, what fails natively, the reason for each page in a `skip`) and
its listed entries a section in `BACKLOG.md`.
