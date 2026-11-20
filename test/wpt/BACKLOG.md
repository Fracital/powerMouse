# What is still on the expected lists, and why

One section per `wpt-*` suite, in alphabetical order. Each entry names the
test page by its key in `expected/<suite>.json` without the leading slash
(the path under `test/wpt/`, with the query of a variant), then the number of
listed entries (subtests, and `(harness)` when the page's own status
differs), what fails through the proxy, and the suspected cause. Pages that
share a cause are one entry. Every entry passes natively on the fixture: a
subtest that fails natively is not compared and is never listed.

State: the lists recorded on 2026-11-15 on the combined tree (Chrome 152,
the proxied run on the runner's own controller, so popups are the
browser's), with the entries that only Chrome 156 or 157 passes natively
merged in (they are native failures on 152 and so not compared there). A
section's closing "Cleared on the combined tree" line names the entries the
streams listed that this record no longer has, and the fix that took each
off where one is known.

## wpt-base-urls

- `html/infrastructure/urls/dynamic-changes-to-base-urls/historical.sub.xhtml`
  (21: the harness TIMEOUT and all 20 subtests MISSING):
  `ReferenceError: test is not defined` at the page's inline script. XHTML
  scripts (README): the re-created document runs the inline script before
  `testharness.js`, an external script ahead of it, has loaded; the XML
  parser waits for it.

## wpt-beacon

The list is empty. Two gaps no kept test measures, from reading the code:

- A beacon from an about:blank popup the page wrote (`window.open('')`, then
  `popup.navigator.sendBeacon`) still goes to the proxy origin's server: the
  relay of a beacon from an uncontrolled frame goes through
  `Client.controlledClient()`, which walks parents only, and a popup has
  none. The opener would be the document to relay through.
- A relayed beacon while the ancestor has close to 64 KiB of its own beacons
  in flight: `#relayBeacon` in `src/inject/dom/modules/Navigator.ts` counts
  only the bytes it relayed, so Chrome can refuse the keepalive fetch and the
  beacon is lost (no retry on purpose: a refused cors-mode beacon may already
  have reached the server).

## wpt-cookies

- `cookies/ordering/ordering.sub.html` (1: "Cookies with longer paths are
  listed before cookies with shorter paths"): the popup's
  `fetch('/cookies/resources/cookie.py?set=...&location=...')`, a redirect
  whose response sets cookies, fails with `TypeError: Failed to fetch` where
  Chrome follows it. Cause not yet known; seen only in a browser popup of
  another site opened by the proxied page. The next step is a worker-side log
  of that fetch (the redirect handling for a client that is a top-level popup
  rather than a frame of the host).

## wpt-cookies-more

- `cookies/samesite/window-open.https.html` (5: "Cross-site ... auxiliary
  navigations are laxly same-site"), `cookies/samesite/form-get-blank.https.html`
  (5: "Cross-site ... top-level form GETs are laxly same-site"): the
  SameSite=Lax cookie is not sent. The first request of a new top-level
  window a cross-site page opens (window.open, a form with `target=_blank`)
  misses the top-level navigation exception: `src/server/rewrites.ts` allows
  Lax only for `navigation && topLevel`, and for the popup's first request
  `topLevel` is apparently false, or `nestedTopOf(referrer)` finds the
  opener's route. Not probed beyond the suite.
- `cookies/samesite/setcookie-lax.https.html` (1: "Cross-site window
  shouldn't be able to set SameSite=Lax or SameSite=Strict cookies"): the
  Strict cookie is set. The converse of the entry above: in `rewrites.ts`
  `crossSiteSet = cookieSite === 'cross-site' && !(navigation && topLevel)`
  lets a top-level navigation set any cookie; which request of the test sets
  them was not probed.
- `cookies/samesite/sandbox-iframe-nested.https.html` (1): the Lax cookie is
  sent with a navigation started inside a sandboxed frame. The initiator's
  opaque origin is lost: the nested navigation carries the sandboxed
  document's real route as referrer and is judged same-site.
- `cookies/samesite/about-blank-subresource.https.html` (2: the harness
  TIMEOUT and its subtest): the page writes into a `window.open("")` popup
  and navigates a frame in it; the popup's about:blank document is not the
  opener's to write. Still listed with the lead's popup and opener fixes and
  the about:blank origin fix in the tree; not probed. Its sibling
  `about-blank-toplevel.https.html` passes since the site pool series
  (1b74600d), whose write hook opens a written popup before its scripts
  run; that this is why was not probed.
- `cookies/samesite/setcookie-navigation.https.html` (9: the harness TIMEOUT
  and 8 subtests MISSING): no report within 30 s. Cause not yet known (not
  triaged); a candidate is the page navigating its own top-level window away
  and back, which in the harness is a frame of the host page.

Cleared on the combined tree: `about-blank-nested.https.html` (the lead's
about:blank origin fix) and the "Subdomain redirecting to same-host fetches
are strictly same-site" subtest of `fetch.https.html` (no fix names it).

## wpt-csp

Nothing here has been fixed: the CSP code (`src/csp.ts`,
`src/server/contentPolicies.ts`, the inject's ContentSecurity module) was
another stream's while these were measured.

- `content-security-policy/connect-src/connect-src-syncxmlhttprequest-redirect-to-blocked.sub.html`
  (1): logging timeout, no violation event. The synchronous XHR goes through
  the inject's sync bridge, where the worker's redirect refusal answers a
  network error but its `postReport` is not turned into a
  `securitypolicyviolation` (the page is blocked in `send()` while it would
  arrive, or the bridge's request has no client id). The async XHR, fetch,
  beacon and EventSource pages of the same kind pass.
- `content-security-policy/frame-src/frame-src-blocked.sub.html` (1): the
  frame loads and posts FAIL. A `<meta>` `frame-src 'none'` does not block a
  frame of the page's own origin: the frame's navigation request carries no
  client id of the parent, `policiesOf(clientId, referrer)` has to find the
  parent's policies by referrer, and for `'none'` against the own origin
  something in `sourcesMatch` or the frame path lets it through.
  Cross-origin frame-src pages pass.
- `content-security-policy/frame-src/frame-src-self-unique-origin.html` (2:
  the harness TIMEOUT and its subtest): the page adds its `<meta>` policy by
  script after the parse (the worker reads meta policies from the markup it
  served, `metaPolicies(markup)`), and in a data: document `'self'` is matched against the proxy's idea of its
  URL (`sourcesMatch` against `document.url` in `src/csp.ts`) instead of an
  opaque origin.
- `content-security-policy/navigation/to-javascript-parent-initiated-parent-csp.html`
  (8: the harness TIMEOUT, 1 FAIL "Javascript url executed", 1 TIMEOUT, 5
  NOTRUN), `content-security-policy/navigation/to-javascript-url-script-src.html`
  (5: the harness TIMEOUT and four subtests),
  `content-security-policy/navigation/to-javascript-parent-initiated-check-csp-order.html`
  (8: the harness TIMEOUT and 7 MISSING): a `javascript:` navigation of a
  child frame or another window runs although the initiator's `script-src`
  forbids it. The proxy runs a `javascript:` URL in the target and checks no
  policy of the document that started it, where Chrome checks the
  initiator's.

Cleared on the combined tree: `frame-src-same-document-meta.sub.html` (no
fix names it).
Cleared by d600d112 (a worker's requests judged by the worker's own policy):
`worker-connect-src-blocked.sub.html`,
`shared-worker-connect-src-blocked.sub.html` and `worker-from-guid.sub.html`.

## wpt-document-write

- The write stream and the parser are not one tokenizer: the inject's write
  stream (`src/inject/dom/WriteStream.ts`) keeps an unfinished tail for the
  next write, but markup written a character at a time and continued by the
  parser's own markup after the `</script>` (which `loadHTML` already parsed
  apart) comes out as other nodes. 26 entries, 1 each unless said:
  - a comment split over writes (nodeType 1 for 8):
    `html/webappapis/dynamic-markup-insertion/document-write/018.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/020.html`;
  - a write that ends inside a start tag (`document.write("<i")`), localName
    undefined: `html/webappapis/dynamic-markup-insertion/document-write/019.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/021.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/023.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/024.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/025.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/026.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/027.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/038.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/039.html`;
  - a write that ends in a partial end tag (`<`, `</`, `</s`), remnants in the
    text: `html/webappapis/dynamic-markup-insertion/document-write/022.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/028.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/029.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/030.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/031.html`;
  - CDATA in foreign content (`<svg><!` then `[CDATA[...]]>` from the
    parser): `html/webappapis/dynamic-markup-insertion/document-write/035.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/036.html`;
  - a doctype token in body written a character at a time:
    `html/webappapis/dynamic-markup-insertion/document-write/037.html`;
  - a character reference split over writes (each write's text is parsed on
    its own, so `&notin;` never forms):
    `html/webappapis/dynamic-markup-insertion/document-write/041.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/042.html`,
    `html/webappapis/dynamic-markup-insertion/document-write/043.html`;
  - an open `<textarea>` that does not switch the parser's markup after it to
    RCDATA: `html/webappapis/dynamic-markup-insertion/document-write/046.html`;
  - `document.write("<plaintext>")`, whose element is not placed where it is
    natively and whose later writes must go to its text:
    `html/webappapis/dynamic-markup-insertion/document-write/050.html`;
  - a `<script src>` written a character at a time inside svg with CDATA
    remnants (2: the harness TIMEOUT and its subtest):
    `html/webappapis/dynamic-markup-insertion/document-write/script_013.html`.
- `html/webappapis/dynamic-markup-insertion/document-write/mutation-observer.html`
  (2: the classic and the async script element): `script should not run`. A
  MutationObserver removes a written `<script>` before it runs: natively the
  observer's microtask comes after the parser inserted the script and before
  it executes, through the proxy the write stream inserts and runs the script
  in one step.
- `html/webappapis/dynamic-markup-insertion/closing-the-input-stream/document.close-01.xhtml`,
  `html/webappapis/dynamic-markup-insertion/document-write/document.write-01.xhtml`,
  `html/webappapis/dynamic-markup-insertion/document-writeln/document.writeln-01.xhtml`
  (2 each: the harness TIMEOUT and its subtest MISSING): XHTML scripts
  (README).

Cleared on the combined tree: `iframe_001.html` to `iframe_010.html` (an
about:blank child's `contentDocument` read null; the lead's about:blank
origin fix).

## wpt-dom-insertion

- `dom/nodes/MutationObserver-cross-realm-callback-report-exception.html` (1:
  "MutationObserver reports the exception from its callback in the
  callback's global object"): `["top"]` for `["frame1"]`, the exception is
  reported in the top's realm, not the frame's.
  `src/inject/dom/modules/MutationObserver.ts` calls the page's callback from
  a wrapper made in the bundle's realm, and an about:blank child runs its
  creator's bundle. Fix idea: catch in `deliver` and report on the
  callback's global with that global's `reportError`.
- `dom/nodes/MutationObserver-transient-registered-observers.window.html` (2):
  - "A removed subtree is no longer observed after mutation observers are
    notified": page scripts run inside the inject's one-piece
    `document.write` (`loadHTML`, from a timer), so there is no microtask
    checkpoint after each parser-inserted script, and the inject's own
    whole-document observers already have the mutation observer microtask
    queued when the page's script runs. Architecture; not fixed.
  - "Removing a node from an observed subtree queues the mutation observer
    microtask" (`["promise","observer"]`): the removal queues Chrome's
    microtask with no record, the later hooked `setAttribute` takes its
    record and hands it back from a microtask queued after the page's
    promise. The module cannot see a queueing without a record.

Cleared on the combined tree: `Node-appendChild.html` (3),
`Node-removeChild.html` (9) and the harness TIMEOUT of the cross-realm page
(an about:blank child read as cross-origin; the lead's about:blank origin
fix).

## wpt-encoding-api

- `encoding/replacement-encodings.any.html`,
  `encoding/replacement-encodings.any.worker.html` (6 each: `csiso2022kr`,
  `hz-gb-2312`, `iso-2022-cn`, `iso-2022-cn-ext`, `iso-2022-kr`,
  `replacement`): a body read through `overrideMimeType` with one of these
  labels decodes as UTF-8 instead of one U+FFFD. The XMLHttpRequest stand-in
  decodes text itself (`decodeText` in
  `src/inject/dom/modules/XMLHttpRequest.ts`) with `new TextDecoder(label)`,
  which throws a RangeError for the replacement encoding's labels, and falls
  back to UTF-8. Fix: map the six labels to one U+FFFD for a non-empty body
  before constructing a decoder.

## wpt-encoding-legacy

- The document's encoding is lost (420 entries): every non-ASCII character a
  link's query or a submitted GET form carries in a legacy-encoded document
  goes as UTF-8, where Chrome percent-encodes it in the document's encoding
  (an unencodable one as `%26%23<decimal>%3B`).
  `encoding/legacy-mb-korean/euc-kr/euckr-encode-form.html?17001-last` (48),
  `encoding/legacy-mb-korean/euc-kr/euckr-encode-href.html?17001-last` (48),
  `encoding/big5-encoder.html` (12), `encoding/iso-2022-jp-encoder.html`
  (11), `encoding/legacy-mb-schinese/gbk/gbk-encoder.html` (48),
  `encoding/legacy-mb-schinese/gb18030/gb18030-encoder.html` (253). The
  worker decodes each document with the encoding the browser would pick and
  serves it as UTF-8 (`decodeDocument` / `utf8ContentType` in
  `src/server/charset.ts`), and the page is never told what it was, so the
  browser encodes its URL queries as UTF-8 and `document.characterSet`,
  `charset` and `inputEncoding` read `UTF-8`. A fix passes the sniffed label
  to the shell (a new Config field), answers the three getters with it, and
  encodes the query of every URL the hooks route and every form submission
  in that encoding; the browser exposes no legacy encoder to script, so the
  inject needs one (tables built by decoding every pointer with TextDecoder
  and inverting, or a detached helper document in that encoding), with the
  standard's stateful steps for ISO-2022-JP. Every variant of these pages but
  the last is in the suite's `skip` until then. `url/percent-encoding.window.html`
  in `wpt-url-elements` has the same cause.
- `encoding/utf-32-from-win1252.html` (3): three frames without a
  declaration read `UTF-8` where they take their same-origin parent's
  `windows-1252`. `decodeDocument` knows nothing of the embedding document,
  so a child frame without a declaration is decoded as UTF-8 whatever its
  parent is (the worker would need the parent's encoding on the frame's
  route).
- `encoding/sniffing.html` (1: "No (UTF-8) sniffing allowed"): a document with
  no declaration at all decodes as UTF-8, where Chrome takes its default
  encoding (windows-1252 for most locales) and never sniffs UTF-8.
  `decodeDocument` falls back to UTF-8; changing the fallback alone is wrong,
  since a frame without a declaration inherits its parent's encoding (the
  entry above) and the default is the browser locale's, which only the
  controller page can read.
- `encoding/legacy-mb-japanese/iso-2022-jp/iso2022jp-encode-form-errors-stateful.html`
  (2: the harness TIMEOUT and its subtest): not the encoder. The form's
  `action` is a `data:` URL, and the form hook routes it through
  `routeHTML`, which makes a rewritten data: URI rather than the `inline:`
  route a frame's `src` gets; the shell in that opaque data: document dies at
  boot (`Failed to execute 'open' on 'XMLHttpRequest': Invalid URL`), so the
  framed document never posts its answer. The encoding cause above waits
  behind it.

Cleared on the combined tree: one MISSING entry each of
`iso2022jp-decode.html?7001-last` and `sjis-decode.html?7001-last`, a
non-ASCII subtest name mangled in the report body (the fixture now reads the
report as one UTF-8 stream, README).

Cleared since: the UTF-16LE frames of `utf-32.html` and
`utf-32-from-win1252.html` (a UTF-32LE byte order mark is a UTF-16LE one).
The HTML one went when a document's shell was served in its own encoding
(e52230ff), and the XML one when an XML document's shell was served in the
encoding the XML rules name (xml-encoding suite).

## wpt-event-handlers

The list is empty.

The suite skips
`html/webappapis/scripting/events/compile-event-handler-settings-objects.html`:
which of its subtests fail proxied changes from run to run, the harness
TIMEOUT with the entry or the incumbent settings subtest. The cause is popup
listeners erased by the shell. The button's handler does
`w = window.open('open-window.html'); w.onload = ...`; natively the browser
keeps the Window for the same-origin document and fires its load there, proxied the popup's shell
`document.open()`s (`loadHTML` in `src/inject/dom/Client.ts`), which erases
every window listener and handler. The same happens to
`iframe.contentWindow.addEventListener('load', ...)` right after inserting a
same-origin iframe with a src. Idea: record the page's listeners on a window
still on its initial about:blank and have the shell add them again after its
`document.open()`.

Cleared on the combined tree: `eventhandler-cancellation.html` (15, an
about:blank child's `onerror` set refused as cross-origin; the lead's
about:blank origin fix).

## wpt-eventsource

- `eventsource/request-credentials.window.html` (4: "credentials enabled"
  FAIL, "credentials disabled", "credentials default" and the harness
  TIMEOUT): the reconnection carries no `Last-Event-ID`. `cors-cookie.py`
  tells its second answer from the first by `Last-Event-ID: 1`, and Chrome
  does not put an EventSource's `Last-Event-ID` in the request a service
  worker's FetchEvent sees (measured in plain Chrome with a pass-through
  worker), so the worker has nothing to forward. The worker has to keep the
  id itself: scan a 200 `text/event-stream` body for the `id` field as the
  spec does, keyed by the stream instance (which the inject's EventSource
  hook has to mark), and set `last-event-id` on the next request of that
  instance, never counted as a CORS-unsafe header. The highest-value entry of
  the area: every stream that resumes after a drop (chat and LLM answer
  streams, live feeds) loses or replays events on each reconnect.
- `eventsource/eventsource-cross-origin-redirect-origin.any.html`,
  `eventsource/eventsource-cross-origin-redirect-origin.any.worker.html` (1
  each: "MessageEvent.origin is the origin of the final URL after a
  cross-origin redirect"): the page reads the first URL's origin. The
  inject's `origin` getter names the URL given to the constructor; the
  browser follows the worker's redirect between routed URLs itself, and
  nothing tells the inject where the stream ended. The worker would tell the
  client the final URL, keyed by the same stream instance marker.

## wpt-eventsource-format

- `eventsource/format-field-id.any.html`,
  `eventsource/format-field-id.any.worker.html`,
  `eventsource/format-field-id-2.any.html`,
  `eventsource/format-field-id-2.any.worker.html`,
  `eventsource/format-field-id-redirect.any.html`,
  `eventsource/format-field-id-redirect.any.worker.html` (1 each,
  "EventSource: Last-Event-ID", "(2)", "after redirect"): the reconnection
  is answered as a first request. No `Last-Event-ID` on a reconnection, as in
  `wpt-eventsource`; the redirect variant also needs the id to survive the
  redirect hop, so the key is the stream instance, not the URL.

## wpt-fetch-abort

- `fetch/api/abort/general.any.html`, `fetch/api/abort/general.any.worker.html`
  (3 each):
  - "Already aborted signal rejects immediately": rejected a few microtasks
    late (`["next-microtask", "fetch-reject"]`). The fetch hook
    (`src/inject/modules/Fetch.ts`) is an async function that awaits before
    it calls the browser's fetch. What matches: a synchronous outer hook that,
    for a signal aborted already, returns `Reflect.apply(target, that, args)`
    (the browser rejects at once and marks the body used), reading
    `init.signal` once; throwing `signal.reason` from the hook breaks
    "Request is still 'used' if signal is aborted before fetching".
  - "Fetch aborted & connection closed when aborted after calling
    response.blob()": the origin's connection stays open (`Timed out`). An
    abort after the response headers, while `blob()` reads: the worker drops
    its record of the pending abort (`pendingAborts` in `rewrites.ts`) when
    the forward returns the response, and a `blob()` read in the browser does
    not cancel the service worker's stream on abort.
  - the no-cors variant of "Underlying connection is closed when aborting
    after receiving response": the connection is already closed when the
    test asks, before it aborts: the worker reads the opaque response's body to its end (or
    cancels it) before the page lets go.

## wpt-fetch-basic

- `fetch/api/basic/header-value-combining.any.html`,
  `fetch/api/basic/header-value-combining.any.worker.html` (6 each,
  `response.headers.get(...)` for each of the six `xhr/resources/*.asis`):
  `TypeError: Failed to fetch`. The files are a status line and LF-only
  header lines with no blank line, written raw and the socket closed; Chrome
  takes EOF as the end of the header block, the transport's HTTP/1 parser
  (epoxy's hyper in wasm) answers an incomplete message and the worker makes
  a network error of it. Not proven by a probe with the blank line added; a
  transport patch (`deploy/epoxy`).
- `fetch/api/basic/request-headers-case.any.html`,
  `fetch/api/basic/request-headers-case.any.worker.html` (2 each, "Multiple
  headers with the same name, different case"): the origin gets
  `This-Is-A-Test: 1, 2` where Chrome keeps the case the page wrote first.
  The worker sees the request's headers through a `Headers` object (names
  lowercased) and the transport writes them title-cased; a fix carries the
  page's name case from the inject to the transport.
- `fetch/api/basic/request-headers-nonascii.any.html`,
  `fetch/api/basic/request-headers-nonascii.any.worker.html` (1 each,
  "Non-ascii bytes in request headers"): the echoed Accept is present but
  empty. The loss is on the way out (the browser hands the service worker
  latin1 strings, which the transport may encode as UTF-8) or on the way back
  (the transport's decoding of a response header that is no UTF-8, then
  `new Headers` in `filterHeaders.ts`); not probed.

## wpt-fetch-cors

- `fetch/api/cors/data-url-worker.html`,
  `fetch/api/cors/data-url-shared-worker.html` (1 each: "fetching "top.txt"
  with CORS allowing null origin should be allowed."): rejected. A worker made
  from a `data:` URL has an opaque origin, so its request carries
  `Origin: null`; through the proxy its client is taken as its creator's
  origin, and the CORS check of the worker (`src/server/cors.ts`) compares
  `null` with the page's origin. Still listed with the lead's opaque and
  about:blank origin fixes in the tree.

## wpt-fetch-credentials-redirect

- `fetch/api/redirect/redirect-location.any.html`,
  `fetch/api/redirect/redirect-location.any.worker.html` (5 each: "Redirect
  30x in "manual" mode with data location"): `TypeError: Failed to fetch`
  where the page gets an opaqueredirect response. The worker routes the
  `Location` (`filterResponseHeaders`), a data: URL has no route, and Chrome
  refuses a service worker's redirect answer whose target is not http(s),
  even for a manual-mode request (likely, not probed). Since an
  opaqueredirect shows the page neither the Location nor the status, a
  manual-mode answer could carry any routable Location.

## wpt-fetch-metadata

- `fetch/metadata/generated/element-link-icon.https.sub.html` (12): MISSING
  (harness TIMEOUT). Chrome fetches no favicon for a document in an iframe,
  and every proxied page is in one (`docs/scramjet-parity.md`, Sec-Fetch
  row). A fix would be the inject issuing the icon request itself for a
  proxied top document.
- `fetch/metadata/generated/element-img-environment-change.https.sub.html`
  (15: TIMEOUT at the cross-site step, the rest NOTRUN): in a document no
  service worker controls, another origin's image loads from a sealed copy
  kept in the memory cache, and Chrome prefers a cached candidate of higher
  density (`AvoidDownloadIfHigherDensityResourceIsInCache`), so the
  environment change makes no request. A limit of sealed copies.

Not on a list: a srcset in a script-made about:blank frame whose smallest
candidate is missing never loads the other candidate after the frame widens
(`placeLoad` in `DOMAttributes.ts` waited for the copies all or nothing). A
fix is held back because no suite page reproduces the failure.

## wpt-fetch-objects

The list is empty.

Cleared on the combined tree: `header-values.any.html` (3) and
`header-values-normalize.any.html` (1), the XMLHttpRequest cases of a header
value with NUL or a line break, which threw `Headers.append`'s TypeError for
Chrome's SyntaxError (the XMLHttpRequest argument checks,
`src/inject/xhrChecks.ts`).

## wpt-history

- `html/browsers/history/the-history-interface/001.html` (37),
  `html/browsers/history/the-history-interface/002.html` (36),
  `html/browsers/history/the-history-interface/joint_session_history/001.html`
  (6): history.length stays 1 ("expected 2 but got 1"), then every later
  step. Joint session history: a navigation in a child frame must add an
  entry to the top's history, and through the proxy a frame's navigations to
  routed URLs are made with `location.replace` (Context.ts `#navigate`, the
  iframe `src` routing), so no entry is added.
- `html/browsers/history/the-history-interface/history_pushstate_url_rewriting.html`
  (8: "should work" for a blob: URL of the page's origin, about:blank,
  about:srcdoc and a data: document, each to itself and with a new hash):
  pushState throws a SecurityError ("cannot be created in a document with
  ...") where Chrome lets such a document rewrite its own URL. The History
  module's check needs the opaque-origin and blob-origin rules
  (`url.origin !== page.origin` against the page URL of an opaque-origin
  document); the credentials cases of the page pass.

Cleared on the combined tree: `history_properties_only_fully_active.html`
(an about:blank child's history read as cross-origin; the lead's about:blank
origin fix, with the history steps fix for the SecurityError behind it) and
the three `javascript:'foo'` cases of `history_pushstate_url_rewriting.html`
(no fix names them). `history_back_cross_realm_method.html` and its forward
and go twins, which the history stream's notes still had open, were off the
list before: the history steps fix makes a borrowed method step the
History's own window.

Passing since the rebase onto 082ac470 (no fix of this series names them):
`traverse-during-unload.html` and `traverse-during-beforeunload.html`.

## wpt-indexeddb

Nothing listed. `IndexedDB/database-names-by-origin.html` (no report
within 30 s before) passes since the site pool series (1b74600d); which of
its changes made it pass was not narrowed.

## wpt-location

- `html/browsers/history/the-location-interface/assign_after_load.html` (1),
  `html/browsers/history/the-location-interface/location-replace-cross-site.html`
  (1: "Setting location.href of a cross-site iframe"): the parent's
  history.length is one short. The History module's `length` getter returns
  `navigation.entries().length` of the reading frame only, by design, so a
  child frame's entry is not counted in the parent's history.
- `html/browsers/history/the-location-interface/location-prototype-setting-same-origin.html`
  (4),
  `html/browsers/history/the-location-interface/location-prototype-setting-cross-origin-domain.sub.html`
  (3),
  `html/browsers/history/the-location-interface/location-prototype-setting-goes-cross-origin-domain.sub.html`
  (2): `Object.setPrototypeOf(location, {})` does not throw,
  `Reflect.setPrototypeOf` returns true. The page's location is an ordinary
  object, where a real Location is an immutable-prototype exotic object; it
  needs a setPrototypeOf guard (the three setters hooked for the stand-in, or
  a Proxy with a setPrototypeOf trap). A detectable tell.
- `html/browsers/history/the-location-interface/location-ancestor-origins-referrerpolicy-unsupported-elements.html`
  (1): `Cannot read properties of null (reading 'contentWindow')`. A frameset
  written into an about:blank iframe's document is not in the document right
  after the write (`getElementById('testFrame')` is null), so the write
  stream does not parse it synchronously. Not reproduced further.

Cleared on the combined tree: `location-getters-about-blank.html`,
`location-hash-about-blank.html` and `location-ancestor-origins-new-object.html`
(an about:blank child's location read as cross-origin; the lead's
about:blank origin fix, with the about:blank fragment and ancestorOrigins
fixes behind it).

Passing at d600d112: "Setting location.href of a cross-site popup" of
`location-replace-cross-site.html` (another window's `location.href` write
makes a history entry there since 211f4cc3).

## wpt-modules

- `html/semantics/scripting-1/the-script-element/module/dynamic-import/string-compilation-base-url-inline-classic.html`,
  `html/semantics/scripting-1/the-script-element/module/dynamic-import/string-compilation-base-url-inline-module.html`
  (2 each: eval and Function "should successfully import"): an inline
  script's base URL is the document base URL when the script was prepared
  (the page then moves `<base>`). STomp names markup scripts for the document
  (`rewriteInlineScripts` sourceURL), so the caller frame cannot tell which
  inline script it is, and the string-code import base falls back to the
  current base. Idea: record the base per inline script at rewrite time.
- `html/semantics/scripting-1/the-script-element/module/dynamic-import/string-compilation-other-document.html`
  (2): the active script is the top page's inline script and the evaluator is
  the iframe's eval or Function; a markup (document-route) caller is taken
  for the frame's own document. Idea: when the caller's document is not this
  client's, use that document's URL.
- `html/semantics/scripting-1/the-script-element/module/import-meta/import-meta-resolve-importmap.html`
  (1: "import(import.meta.resolve(x)) can be different from import(x)"):
  Failed to fetch `.../import-meta/start`. Import map keys that are URL-like
  (`"./start"`) are kept as written (`rewriteImportMap` routes the targets
  only), and the browser matches them against routed import URLs, which
  never match. Idea: route URL-like keys as the import helper routes a
  specifier.
- `html/semantics/scripting-1/the-script-element/module/module-import-referrer.html`
  (2: dynamic imports from inline and from external modules, Referer ""),
  `html/semantics/scripting-1/the-script-element/module/referrer-origin.sub.html`
  (2: the localhost origin where the importing module's is wanted): an
  import's Referer is the document's, or none. A static or dynamic
  import's referrer must be the importing module's URL under its
  Referrer-Policy response header; the worker computes it for a
  `js:genericModule` request from the document (the lead's referrer area).
- `html/semantics/scripting-1/the-script-element/module/dynamic-import/string-compilation-nonce-classic.html`,
  `html/semantics/scripting-1/the-script-element/module/dynamic-import/string-compilation-nonce-module.html`
  (2 each: inline event handlers must not inherit the nonce): `import()` from
  an event handler is not refused under a `script-src` with a nonce. STomp's
  CSP emulation lets it through (`src/csp.ts`, the ContentSecurity module).
- `html/semantics/scripting-1/the-script-element/module/dynamic-import/alpha/base-url.sub.html`,
  `html/semantics/scripting-1/the-script-element/module/dynamic-import/alpha/base-url-worker-importScripts.html`
  (1 each): a relative `import()` resolves where natively it fails. A no-cors
  cross-origin classic script (or importScripts) has a muted, sanitized base
  URL natively, and the rewriter is given the script's real URL for every
  classic script. Idea: the worker passes a base it knows is muted.
- `html/semantics/scripting-1/the-script-element/module/module-in-xhtml.xhtml`
  (1: the harness TIMEOUT; its one subtest fails natively): XHTML scripts
  (README), `async_test is not defined`.
- Native failures on Chrome 152 that Chrome 156 and 157 pass natively, so
  they are compared on those (cause not yet known):
  `html/semantics/scripting-1/the-script-element/module/dynamic-import/repeated-imports.any.html`
  (1: "An import should succeed even if the same specifier/type attribute
  pair previously failed due to a MIME type mismatch", `"1"` for `"2"`: a
  repeated import after a failed one),
  `html/semantics/scripting-1/the-script-element/module/dynamic-import/shared-dependency-repeated-import.https.html`,
  `html/semantics/scripting-1/the-script-element/module/shared-dependency-repeated-import.https.html`
  (1 each: "Module shared dependency import", an error is caught while a
  shared dependency is imported twice).

Cleared on the combined tree: `inactive-context-import.html` (an about:blank
child's `eval` read as cross-origin; the lead's about:blank origin fix).
Module scripts are decoded by their Content-Type charset only when it names
windows-1252 (or latin1, iso-8859-1, us-ascii), as Chrome 152 and 157 do,
so the module `charset-01` and `charset-03` pages are not listed.
`module/integrity.html` passes since master verifies a module's integrity
(the rebase onto 082ac470).

## wpt-referrer-policy

The list is empty.

## wpt-script-element

- `html/semantics/scripting-1/the-script-element/script-defer-xhtml.xhtml`
  (1: the harness ERROR `t is not defined`),
  `html/semantics/scripting-1/the-script-element/script-for-event-xhtml.xhtml`,
  `html/semantics/scripting-1/the-script-element/script-noembed-noframes-iframe.xhtml`,
  `html/semantics/scripting-1/the-script-element/script-text-xhtml.xhtml` (2
  each: the harness TIMEOUT and its subtest MISSING): XHTML scripts (README).
  The suite skips `script-type-and-language-js-xhtml.xhtml` (457 subtests)
  for the same cause, because its proxied verdict flips.
- `html/semantics/scripting-1/the-script-element/microtasks/checkpoint-after-workerglobalscope-onerror-module.html`
  (1: "Promise resolved during event handlers other than error", `handler 2`
  where `handler 1 promise` is expected): in a module worker, a promise one
  `error` listener resolves settles after the next listener runs, where
  natively a microtask checkpoint runs between listeners. Not traced: a
  listener the inject calls from its own dispatch (rather than the browser
  calling each) would run them with no checkpoint between. (The harness
  ERROR `Cannot read properties of undefined (reading 'releaseHeld')` it
  had, with two MISSING, went with the module worker's one shared boot.)
- `html/semantics/scripting-1/the-script-element/script-text-modifications.html`,
  `html/semantics/scripting-1/the-script-element/script-text-modifications-csp.html`
  (1 each: "Modify inline script element's text after prepare-a-script before
  evaluation"): `textContent` reads the original text, not the one the page
  set between prepare and run. The Readback sources
  (`src/inject/dom/modules/Readback.ts`) answer the text the proxy rewrote at
  insertion. Not confirmed by a probe.

Cleared on the combined tree: `fetch-src/failure.html`,
`src-empty-or-invalid-error-event-queued.html` and
`script-onerror-insertion-point-2.html` (URL's TypeError thrown out of the
hooks for a `src` that does not parse; the unparsable URL attribute fix), and
`script-charset-01.html` (the response's `charset=windows-1250` now wins over
the element's `charset="utf-8"`; the script charset fix).

Cleared since: `muted-errors.sub.html` (a classic script whose redirects went
through another origin and came back is muted, as natively; df5409bc).

## wpt-script-timing

- `html/semantics/scripting-1/the-script-element/execution-timing/106-import-xhtml.xhtml`,
  `html/semantics/scripting-1/the-script-element/execution-timing/106-noimport-xhtml.xhtml`,
  `html/semantics/scripting-1/the-script-element/execution-timing/150-import-xhtml.xhtml`,
  `html/semantics/scripting-1/the-script-element/execution-timing/150-noimport-xhtml.xhtml`
  (2 each: the harness TIMEOUT and its subtest MISSING): XHTML scripts
  (README).
- `html/semantics/scripting-1/the-script-element/execution-timing/138.html`,
  `html/semantics/scripting-1/the-script-element/execution-timing/139.html`,
  `html/semantics/scripting-1/the-script-element/execution-timing/143.html`
  (2 each: the harness ERROR `SyntaxError: Unexpected token '.'` or `':'` and
  its subtest), `html/semantics/scripting-1/the-script-element/execution-timing/140.html`
  (1: only "external script #1" ran): an SVG `<script>` with a nested
  `<script>` child. `rewriteInlineScripts` (`src/inject/dom/Client.ts`)
  reads the outer script's `textContent`, the inner script's text included,
  and writes it back, which deletes the nested element and runs its text as
  part of the outer one. Reading and writing only the own text children was
  tried and is not enough: a second reader of the SVG script's text (the
  worker's prewrite scan or the shell's write of the markup) still mangles
  it.
- `html/semantics/scripting-1/the-script-element/execution-timing/123.html`,
  `html/semantics/scripting-1/the-script-element/execution-timing/126.html`
  (1 each): script-inserted `async=false` scripts run out of insertion order
  (`["external script #2", "external script #1"]`). A script whose type was
  first not JavaScript and then changed, or whose data changed, is
  re-inserted by the inject's insertion hooks out of that order. Not probed
  further.

Cleared on the combined tree: `070.html` to `075.html`, `083.html`,
`084.html`, `094.html` and `101.html` of `execution-timing/` (18 entries, an
about:blank child read as cross-origin; the lead's about:blank origin fix).

## wpt-url

The list is empty.

## wpt-url-elements

- `url/failure.html` (186: "XHR: <input> should throw"): `open()` does not
  throw. The stand-in's `open()` stores `String(url)` and resolves it only at
  `send()`. Fix: parse against the client's base URL in `open()`, after the
  method checks, and throw the browser's SyntaxError DOMException.
- `url/failure.html` (186: "window.open(): <input> should throw"):
  `TypeError: Failed to construct 'URL': Invalid URL` for a SyntaxError. The
  `window.open` hook (`src/inject/dom/modules/DOMHooks.ts`) parses its first
  argument unguarded; it needs the same catch, with Chrome's message
  ("Unable to open a window with invalid URL").
- `url/percent-encoding.window.html` (8: big5, euc-kr, windows-1252,
  iso-2022-jp (2), gb18030, shift_jis, iso-8859-2): a link's query is
  percent-encoded as UTF-8, not in the document's encoding. The same cause as
  the encode pages of `wpt-encoding-legacy`.
- `url/a-element.html?exclude=(file|javascript|mailto)`,
  `url/a-element-xhtml.xhtml?exclude=(file|javascript|mailto)` (3 each,
  against a base with `user:pass@`): the href loses the base's credentials.
  `DocumentClient.baseURL` is the browser's base URL parsed back from the
  route the `<base href>` hook wrote, and a route carries no userinfo.
- `url/a-element.html?include=file`, `url/a-element-xhtml.xhtml?include=file`
  (3 each, `file:` URLs with empty path segments): `pathname` `/p` for
  `//p`. The link's URL parts are read from a second parse
  (`linkURL` in `src/inject/dom/modules/Anchor.ts` parses the serialization
  again), and Chrome's serialization of these URLs does not parse back to the
  same path. Fix: parse the written attribute against the base once.
- `url/javascript-urls.window.html` (1: "javascript: URL without an opaque
  path"): the code never runs. `routeHTML` rewrites a `javascript:` URL from
  `resource.url.href` passed through `decodeURIComponent`
  (`src/rewriteHTML.ts`): the URL parser has already made a hierarchical URL
  of `javascript://host/...` and the whole string is decoded at once, so the
  rewritten code is not what the page wrote.
- `url/data-uri-fragment.html` (1: "Data URI parsing of fragments"): `:target`
  does not match. A `data:` frame is served from an `inline:` route and its
  fragment travels sealed, so the real document's fragment is not `foo`; a
  `blob:` frame keeps its fragment.

Cleared on the combined tree: the 186 "Location's href: <input> should
throw" subtests of `url/failure.html`, where the Location stand-in threw
URL's TypeError for the frame realm's SyntaxError (the unparsable Location
URL fix hands such a URL to the browser's own setter).

## wpt-websockets

The stand-in is `src/inject/modules/WebSocket.ts` (`MockWebSocket`). The
pages that need the server's answer to a message run since epoxy-transport
delivers a frame as it arrives (README, websockets); the ten of them that
still fail are the last group below.

- Argument checks and errors of the stand-in (S each):
  - the constructor never validates the subprotocols (token, no separators,
    no duplicates), so it connects where Chrome throws a SyntaxError:
    `websockets/constructor/004.html?default` (161),
    `websockets/constructor/007.html?default` (1),
    `websockets/constructor/021.html?default` (1),
    `websockets/Create-asciiSep-protocol-string.any.html?default`,
    `websockets/Create-asciiSep-protocol-string.any.worker.html?default`,
    `websockets/Create-nonAscii-protocol-string.any.html?default`,
    `websockets/Create-nonAscii-protocol-string.any.worker.html?default`,
    `websockets/Create-protocol-with-space.any.html?default`,
    `websockets/Create-protocol-with-space.any.worker.html?default`,
    `websockets/Create-protocols-repeated.any.html?default`,
    `websockets/Create-protocols-repeated.any.worker.html?default` (1 each);
  - `close()` throws a DOMException without a name, turns a non-number code
    into 0 instead of clamping it, and has no reason length check:
    `websockets/Close-1005.any.html?default`,
    `websockets/Close-1005.any.worker.html?default`,
    `websockets/Close-2999-reason.any.html?default`,
    `websockets/Close-2999-reason.any.worker.html?default`,
    `websockets/Close-onlyReason.any.html?default`,
    `websockets/Close-onlyReason.any.worker.html?default`,
    `websockets/Close-Reason-124Bytes.any.html?default`,
    `websockets/Close-Reason-124Bytes.any.worker.html?default` (1 each),
    `websockets/close-invalid.any.html?default`,
    `websockets/close-invalid.any.worker.html?default` (6 each);
  - a close reason with an unpaired surrogate is not made well-formed:
    `websockets/Close-reason-unpaired-surrogates.any.html?default`,
    `websockets/Close-reason-unpaired-surrogates.any.worker.html?default` (1
    each);
  - `send()` while connecting throws a DOMException without the name
    InvalidStateError: `websockets/Send-before-open.any.html?default`,
    `websockets/Send-before-open.any.worker.html?default`,
    `websockets/interfaces/WebSocket/send/003.html?default` (1 each);
  - lone surrogates throw (from the transport's encoder) where they go as
    U+FFFD: `websockets/interfaces/WebSocket/send/004.html?default` (3);
  - `send()` after `close()` must drop the data and count it in
    bufferedAmount, and null must go as the string "null":
    `websockets/interfaces/WebSocket/send/007.html?default`,
    `websockets/interfaces/WebSocket/send/012.html?default` (1 each).
- bufferedAmount is always 0 (`get bufferedAmount() { return 0; }`; the
  stand-in never counts what it handed the transport):
  `websockets/Send-data.any.html?default`,
  `websockets/Send-data.any.worker.html?default`,
  `websockets/Send-65K-data.any.html?default`,
  `websockets/Send-65K-data.any.worker.html?default`,
  `websockets/Send-paired-surrogates.any.html?default`,
  `websockets/Send-paired-surrogates.any.worker.html?default`,
  `websockets/Send-unicode-data.any.html?default`,
  `websockets/Send-unicode-data.any.worker.html?default`,
  `websockets/bufferedAmount-unchanged-by-sync-xhr.any.html?default`,
  `websockets/bufferedAmount-unchanged-by-sync-xhr.any.worker.html?default`,
  `websockets/interfaces/WebSocket/bufferedAmount/bufferedAmount-getting.html?default`,
  `websockets/interfaces/WebSocket/bufferedAmount/bufferedAmount-large.html?default`,
  `websockets/interfaces/WebSocket/bufferedAmount/bufferedAmount-unicode.html?default`
  (1 each). When the transport's send resolves is not when the bytes left,
  which matters to a page that throttles on bufferedAmount.
- Closing while connecting: `readyState` reports CLOSING only when the
  transport socket is open, and `close()` during CONNECTING does not fail
  the connection (error, then close 1006, in a task of their own):
  `websockets/interfaces/WebSocket/close/close-basic.html?default`,
  `websockets/interfaces/WebSocket/close/close-connecting.html?default`,
  `websockets/interfaces/WebSocket/close/close-connecting-async.any.html?default`,
  `websockets/interfaces/WebSocket/close/close-connecting-async.any.worker.html?default`,
  `websockets/interfaces/WebSocket/close/close-nested.html?default`,
  `websockets/interfaces/WebSocket/readyState/003.html?default` (1 each,
  `expected 2 but got 0`); in the same area
  `websockets/Close-delayed.any.html?default`,
  `websockets/Close-delayed.any.worker.html?default` (1 each: the close event
  fires before the server's delayed handshake answer) and
  `websockets/interfaces/WebSocket/events/013.html?default` (4: event objects
  `null`).
- `websockets/opening-handshake/005.html?default` (1: "response header and
  close frame in same packet"): 1005 for 1001. A close frame that arrives
  with the handshake response is reported as no status; the transport or the
  stand-in's close code mapping, not traced.
- Event handler attributes: setting `onopen`, `onclose`, `onerror` or
  `onmessage` to null or a non-callable keeps the old handler
  (`onEventTarget()` in `src/inject/modules/Proxy.ts` ignores a set to a
  non-function; shared with the XMLHttpRequest and EventSource stand-ins):
  `websockets/eventhandlers.any.html?default`,
  `websockets/eventhandlers.any.worker.html?default`,
  `websockets/interfaces/WebSocket/events/010.html?default`,
  `websockets/interfaces/WebSocket/events/014.html?default` (4 each).
- `websockets/Create-on-worker-shutdown.any.html`,
  `websockets/Create-on-worker-shutdown.any.worker.html` (1 each: "WebSocket
  created after a worker self.close()"): the stand-in does not know the
  worker is closing (natively the socket is born failing).
- Pages that wait for the server's answer, run since the transport's frame
  flush (epoxy 0061), failing for their own reasons (measured identical in
  six runs on Chrome 152 and 156 with the fixed transport):
  - bufferedAmount reads 0 right after `send()` (the bufferedAmount group
    above): `websockets/Send-binary-arraybuffer.any.html?default`,
    `websockets/Send-binary-arraybuffer.any.worker.html?default`,
    `websockets/Send-binary-65K-arraybuffer.any.html?default`,
    `websockets/Send-binary-65K-arraybuffer.any.worker.html?default`;
  - `send()` hands a value that is neither a string nor binary (null, a
    number, an object) to the transport, which throws "Invalid websocket
    payload: JsValue(..)" where the browser sends `String(value)` (the
    send/012 row above): `websockets/Send-null.any.html?default`,
    `websockets/Send-null.any.worker.html?default`,
    `websockets/interfaces/WebSocket/send/010.html?default`,
    `websockets/constructor/013.html?default` (013 sends `this.id`, a
    number; 25 sockets at once work);
  - a frame with a reserved opcode after open fires no error event through
    the proxy (epoxy's read loop errors; not traced where the error is lost:
    the transport's connect, the transport worker or the stand-in):
    `websockets/interfaces/WebSocket/events/018.html?default`;
  - a handshake answer with a wrong Sec-WebSocket-Accept is taken: epoxy's
    `verify()` (client/src/websocket.rs) never checks the accept key, so the
    socket opens where Chrome fails it:
    `websockets/security/001.html?default`.

## wpt-webstorage

The proxied Storage is `src/inject/dom/modules/Storage.ts`, a Proxy over a
StorageProxy whose calls are synchronous beacons to the service worker, which
keeps the stores (`src/server/Storage.ts`).

- sessionStorage changes never fire a `storage` event in the origin's other
  frames: the worker's change message is dropped for any store but
  localStorage (`if (change.store !== 'localStorage') return`), since the
  worker keeps one sessionStorage per origin and an event would reach other
  tabs. `webstorage/event_basic.html`, `webstorage/event_body_attribute.html`,
  `webstorage/event_case_sensitive.html`, `webstorage/event_setattribute.html`
  (1 each: the sessionStorage subtest, "only got 0, expected 1 events");
  `webstorage/event_no_duplicates.html` (7),
  `webstorage/event_session_key.html`, `webstorage/event_session_newvalue.html`,
  `webstorage/event_session_oldvalue.html`,
  `webstorage/event_session_removeitem.html`,
  `webstorage/event_session_storagearea.html`,
  `webstorage/event_session_url.html` (2 each: the harness TIMEOUT and its
  subtest).
- `webstorage/storage_session_window_noopener.window.html`,
  `webstorage/storage_session_window_open.window.html` (1 each): a noopener
  popup reads the opener's value, the opener reads its popup's. sessionStorage
  is one store per origin in the worker, shared by every tab and window,
  where natively each top-level browsing context has its own (a popup with an
  opener starts with a copy, a noopener one empty). Needs a per-tab key in
  the store's directory. High relevance: two tabs of one site overwrite each
  other's per-tab state.
- `webstorage/event_constructor.window.html`,
  `webstorage/event_initstorageevent.window.html` (1 each):
  `Failed to convert value to 'Storage'`. The page's `localStorage` is STomp's
  Proxy,
  which the native StorageEvent constructor and `initStorageEvent` refuse as
  `storageArea`; both need the dispatch path's workaround (pass null, define
  `storageArea` after).
- `webstorage/defineProperty.window.html` (12): the Proxy has no
  `defineProperty` trap, so `Object.defineProperty(localStorage, k, {value})`
  defines an own property instead of calling the named setter.
- `webstorage/document-domain.html` (2: the harness TIMEOUT and
  "localStorage and document.domain" TIMEOUT): timing dependent, cause not
  yet known. It also fails alone at 8d040b33 and at 5bd9c474 with this
  harness, where the sub-streams' own records passed it. At the base the
  page read `frames[0]` of a parser-made about:blank iframe as
  cross-origin (`Blocked a frame ... cross-origin frame`).

The suite skips the four quota pages, which crash the proxied tab (README,
workers, webstorage, IndexedDB).

## wpt-windows

- `html/browsers/windows/noreferrer-window-name.html` (1: "Targeting a
  rel=noreferrer link at an existing named window should work"): the opener
  reads the popup's old URL after the popup moved to a blob: document. The
  handle the opener keeps (Context.ts `held`) is not let go when the popup's
  document changes; with the lead's per-document holds it still fails,
  either because the blob: document is the opener's origin (so the hold
  rightly stays and the read goes to the stale about:blank realm) or because
  the read is of the window's old Location. Not narrowed.
- `html/browsers/windows/browsing-context-names/choose-_parent-002.html` (1):
  `undefined` for `"iframeParent"`, in a popup only (the same tree in frames
  of the page passes). Inference, not traced: a message other than the
  page's own, probably one of the proxy's, reaches the popup page's `message`
  listener, which relays it to the opener.
- `html/browsers/windows/embedded-opener-remove-frame.html` (1: the harness
  TIMEOUT): timing dependent, cause not yet known. It also fails alone at
  8d040b33 and at 5bd9c474 with this harness, where the sub-streams' own
  records passed it.

Cleared on the combined tree: `frameElement.sub.html` (`frames[0]`, an
about:blank iframe, read as cross-origin; the lead's about:blank origin
fix).

## wpt-workers-basics

- `workers/opaque-origin.html` (1: "Worker has an opaque origin."):
  `self.location.origin` is the proxy's. A blob: worker whose Blob has no
  JavaScript type runs unrewritten (`BlobDocuments.ts` rewrites a Blob at
  construction only for a JavaScript type, and the Worker hook imports any
  other Blob as it is), so `self.location` is the browser's. High relevance:
  `new Worker(URL.createObjectURL(new Blob([code])))` is the usual inline
  worker.
- `workers/shared-worker-from-blob-url.window.html` (4: the harness,
  "Creating a shared worker from a blob URL works.", "Connecting to a shared
  worker on a revoked blob URL works." and one NOTRUN): two
  `new SharedWorker(blobURL)` are two workers. Each construction makes a new
  bootstrap blob (`workerURL` in `src/inject/modules/Worker.ts`), and the
  browser keys a shared worker by its script URL; a revoked URL cannot
  connect at all. Needs one bootstrap URL per page blob URL and name.
- `workers/dedicated-worker-from-blob-url.window.html` (1: "Blob URLs should
  not resolve relative to document base URL."): by design so far, a blob:
  worker resolves relative URLs against the page that made it (`WORKER_BASE`),
  where natively the base is the blob: URL.
- `workers/shared-worker-options-mismatch.html` (4): a second SharedWorker of
  the same URL and name with another `type` loads where it must fire
  `error`; the two constructions are two routes (`js:worker` and
  `js:workerModule`, `src/scriptRoutes.ts`). The constructor hook would have
  to remember type and credentials per URL and name.
- `workers/worker-url-encoding.html` (1): `?%C3%9F` for `?%DF`. Every
  proxied document is UTF-8 (`src/server/charset.ts`), so URL queries of a
  legacy-encoded page are percent-encoded as UTF-8; the cause of the
  `wpt-encoding-legacy` encode pages.
- `workers/dedicated-worker-in-data-url-context.window.html` (1):
  `Failed to execute 'open' on 'XMLHttpRequest': Invalid URL`. A data: URL
  worker that
  starts another one has to rewrite its source and has no rewriter library
  and no base to fetch it against.
- `workers/Worker-postMessage-happens-in-parallel.https.html` (2: the harness
  ERROR `SharedArrayBuffer is not defined` and a TIMEOUT): the page asks for
  cross-origin isolation, and a proxied frame is isolated only when the host
  page is; the runner's host is not. A known limit.

Cleared on the combined tree: `SharedWorker-detach-frame-in-error-event.html`
(a frame's `document` read as cross-origin; the lead's about:blank origin
fix, by its message).

## wpt-workers-constructors

The list is empty (`workers/constructors/Worker/constructor-utf16-bom.html` left it
with the script charset fix).

## wpt-workers-modules

- A module worker started from a data: URL never starts (harness ERROR
  `TypeError: Failed to fetch`): its lead (`src/scriptLead.ts`, the
  `workerModule` branch) fetches `dist/injectWorker.js` from the proxy
  origin, and a data: worker has an opaque origin and no service worker, so
  that is a cross-origin request without CORS. A classic data: worker uses
  importScripts, which needs no CORS, and works. Needs the bundle inlined for
  this case or served with CORS.
  `workers/modules/dedicated-worker-import-data-url.any.html`,
  `workers/modules/dedicated-worker-import-data-url.any.worker.html`,
  `workers/modules/shared-worker-import-data-url.window.html` (10 each),
  `workers/modules/dedicated-worker-import-data-url-cross-origin.html`,
  `workers/modules/shared-worker-import-data-url-cross-origin.html` (5 each).
  From inside a worker (`.any.worker.html`) the harness ERROR reads
  `Error in remote data:...`.
- `workers/modules/dedicated-worker-import-blob-url.any.worker.html` (10:
  `Failed to fetch dynamically imported module: blob:...`): a blob: module
  worker started from inside a worker; the nested bootstrap (`workerURL`, the
  `isModule` branch) imports the page's blob by its private URL made in the
  worker, and that import fails. From a document the same test passes. Not
  narrowed further.

Cleared on the combined tree: the "eval(import())." subtests of
`dedicated-worker-import-blob-url.any.html` and
`shared-worker-import-blob-url.window.html` (in a blob: module worker,
evaluated code resolved its specifier against an http: URL; no fix names
it). Passing at d600d112 (a worker's imports judged by its own policy):
`dedicated-worker-import-csp.html` (5) and `shared-worker-import-csp.html`
(4).

## wpt-workers-scope

The list is empty.

## wpt-workers-semantics

- `workers/semantics/navigation/001.html`, `workers/semantics/navigation/002.html`
  (2 each: the harness TIMEOUT and "navigating"): a frame navigated to a
  `data:text/html,...` URL by a link click gets the shell, which cannot
  rewrite its inline script: the document is opaque, has no reachable top to
  take the rewriter library from, and asks for it with a synchronous XHR to a
  relative URL that does not parse against a data: base. `iframe.src = data:`
  is not affected (it gets a blob copy).

Cleared by the importScripts fix (a script of another origin throws a
NetworkError, one of the worker's own origin is not caught):
`importScripts/catch.sub.any.worker.html` and `.sharedworker.html`, the 12
`importScripts/report-error-*` pages, and in wpt-workers-basics
`Worker-nested-importScripts-error.html`.

## wpt-xhr-cors

The XMLHttpRequest stand-ins are `src/inject/dom/modules/XMLHttpRequest.ts`
(documents) and `src/inject/worker/modules/XMLHttpRequest.ts` (workers),
sharing `src/inject/xhrText.ts`.

- `xhr/access-control-preflight-credential-async.htm`,
  `xhr/access-control-preflight-credential-sync.htm` (1 each): 401. The
  credentials of the URL are not applied after the preflight.
- `xhr/cors-upload-listener-timing.any.html`,
  `xhr/cors-upload-listener-timing.any.worker.html` (4 each),
  `xhr/event-upload-progress-crossorigin.any.html`,
  `xhr/event-upload-progress-crossorigin.any.worker.html` (2 each: "Upload
  events registered too late"): upload listeners added after `send()` count
  (`src/inject/uploadListeners.ts`), so a preflight is forced or upload
  events fire where natively they do not.

The suite skips `xhr/access-control-basic-allow-preflight-cache-timeout.any.html`
and `xhr/access-control-basic-allow-preflight-cache-timeout.any.worker.html`,
whose proxied verdict flips (window: FAIL three runs, then PASS two; worker:
FAIL, PASS, PASS): the second PUT reads the first PUT's answer, a cached or
replayed response rather than the preflight cache (the expiry in
`src/server/cors.ts` looks right). Not traced.

Cleared on the combined tree: the four `access-control-and-redirects` pages
(`-async.any.html`, `-async.any.worker.html`, `.any.html`,
`.any.worker.html`; a redirect with user info to `*`, a remote sync redirect
to the local origin), no fix names them.

## wpt-xhr-events

A fix of the abort and progress entries below was drafted by the xhr stream,
not built or tested.

- `abort()` fires its events in every state and leaves DONE, where the spec
  fires abort only for a request in flight and ends in UNSENT after DONE
  (`#end('abort')`): `xhr/abort-after-receive.any.html`,
  `xhr/abort-after-receive.any.worker.html`, `xhr/abort-after-timeout.any.html`,
  `xhr/abort-after-timeout.any.worker.html`, `xhr/abort-after-stop.window.html`,
  `xhr/abort-during-headers-received.window.html`,
  `xhr/abort-during-loading.window.html`, `xhr/abort-event-order.htm`,
  `xhr/abort-progress-events.any.html`,
  `xhr/abort-progress-events.any.worker.html`, `xhr/open-after-abort.htm`,
  `xhr/open-send-during-abort.htm` (`send()` in the abort handler throws
  "state must be OPENED"), `xhr/event-error-order.sub.html`
  (1 each), `xhr/abort-during-done.window.html` (3), and "abort() during
  loadstart" of `xhr/loadstart-and-state.html` (1).
- The upload side of the same: `xhr/abort-during-upload.any.html`,
  `xhr/abort-during-upload.any.worker.html`,
  `xhr/event-loadstart-upload.any.html`,
  `xhr/event-loadstart-upload.any.worker.html` (1 each,
  `upload.loadstart(N,N,true)`).
- `xhr/event-timeout-order.any.html`, `xhr/event-timeout-order.any.worker.html`
  (1 each: "event - timeout (order of events)", `upload.loadstart(0,12,true)`
  expected): cause not yet known (no source names the page; the message is
  the one `event-error-order` shows).
- "open() during loadstart" of `xhr/loadstart-and-state.html` (1):
  `Maximum call stack size exceeded.` (in the handover, `setRequestHeader`
  during loadstart did not throw). The xhr stream put it with the argument
  checks, but it stayed after them; cause not yet known.
- Progress numbers: `lengthComputable` and `total` are taken from the decoded
  body, where Chrome gives false and 0 without a Content-Length or for an
  encoded body: `xhr/firing-events-http-no-content-length.html`,
  `xhr/progress-events-response-data-gzip.htm` (1 each).
- Synchronous requests dispatch the async event set (loadstart and progress
  fire): `xhr/sync-no-progress.any.html`, `xhr/sync-no-progress.any.worker.html`,
  `xhr/send-sync-response-event-order.htm`,
  `xhr/send-sync-no-response-event-order.htm`,
  `xhr/send-response-event-order.htm` (1 each).
- A synchronous request to a `data:` URL fails (`Failed to load 'data:,'`):
  the sync path (the Sync.ts bridge through the service worker) cannot load a
  data: URL. `xhr/xmlhttprequest-sync-block-scripts.html`,
  `xhr/xmlhttprequest-sync-block-defer-scripts.html` (1 each).
- `xhr/event-upload-progress.any.html`, `xhr/event-upload-progress.any.worker.html`
  (2 each: "Upload events registered too late"): late upload listeners, as in
  `wpt-xhr-cors`.

## wpt-xhr-request

- `send()` body conversion and Content-Type (a drafted fix, not built or
  tested):
  - views on a SharedArrayBuffer are not refused:
    `xhr/send-data-sharedarraybuffer.any.html`,
    `xhr/send-data-sharedarraybuffer.any.worker.html` (14 each);
  - a non-BodyInit body (an object, a number, a boolean) goes to fetch as it
    is, which sends nothing for a number, and is converted after the state
    checks: `xhr/send-data-es-object.any.html`,
    `xhr/send-data-es-object.any.worker.html`,
    `xhr/send-data-unexpected-tostring.htm` (4 each),
    `xhr/send-entity-body-basic.htm` (5);
  - a Document body is not serialized and gets no default type, the page's
    charset is not rewritten to UTF-8, and Accept `*/*` is not added:
    `xhr/send-entity-body-document.htm` (7),
    `xhr/send-entity-body-document-bogus.htm` (4),
    `xhr/send-document-lone-surrogate.html` (1),
    `xhr/setrequestheader-content-type.htm` (9),
    `xhr/send-content-type-string.htm` (2),
    `xhr/send-content-type-charset.htm`, `xhr/send-usp.any.html`,
    `xhr/send-usp.any.worker.html`, `xhr/send-accept.htm` (1 each);
  - a Blob without a type (sizes differ): `xhr/send-blob-with-no-mime-type.html`
    (4), not traced, probably the same body path.
- The case of request header names on the wire: lowercased by `Headers`,
  then title-cased on the way out (`src/server/headerOrder.ts` or the
  transport, suspected): `xhr/setrequestheader-case-insensitive.htm` (2),
  `xhr/setrequestheader-header-allowed.htm` (1: `Status-Uri` for
  `Status-URI`), `xhr/setrequestheader-header-forbidden.htm` (1).
- `xhr/setrequestheader-open-setrequestheader.htm` (1): headers set before a
  second `open()` survive in some path. Not traced.
- The server's reason phrase is replaced by the standard one for the code
  (`Not Modified`, `Moved Permanently`): `xhr/send-conditional.htm` (2),
  `xhr/send-redirect-no-location.htm` (4). Not traced: the transport (epoxy
  exposes the canonical reason) or the worker's `new Response`.
- blob: URL requests: the Content-Length of a fetched blob: URL:
  `xhr/request-content-length.any.html`,
  `xhr/request-content-length.any.worker.html` (1 each).
- `xhr/open-url-base-inserted-after-open.htm` (1): "bottom" for "top". The
  stand-in resolves the URL at `send()`, not at `open()`.

Cleared on the combined tree: `open-url-about-blank-window.htm` (an
about:blank window's `XMLHttpRequest` read as cross-origin; the lead's
about:blank origin fix). Passing since the rebase onto 082ac470:
`open-url-multi-window-6.htm`. Passing at d600d112 (a worker's synchronous
XMLHttpRequest): `blob-range.any.worker.html` (17).

## wpt-xhr-response

- The status: a custom reason phrase becomes the standard one
  (`xhr/status-async.htm`, `xhr/status-basic.htm`, 18 each, with the status
  699 cases), and a status outside 200 to 599 makes the worker's
  `new Response(..., { status })` throw a RangeError, so the page sees a
  network error (`xhr/status-error.htm`, 4).
- A response header `Headers` or the transport refuses (odd names, values,
  whitespace) ends in an error event: `xhr/getallresponseheaders.htm` (7),
  `xhr/getresponseheader.any.html`, `xhr/getresponseheader.any.worker.html`
  (6 each), `xhr/getallresponseheaders-after-reuse.html` (1). Not traced.
- `xhr/getresponseheader-special-characters.htm` (1): `Headers.get` throws
  for a name that is no token; return null first.
- responseType: an unknown value is kept, and the setter checks the state
  before the value: `xhr/responsetype.any.html` (4),
  `xhr/responsetype.any.worker.html` (6), `xhr/historical.html` (1,
  `moz-chunked-arraybuffer`).
- The final MIME type: no Content-Type means `text/xml`:
  `xhr/responsexml-media-type.htm` (4), `xhr/overridemimetype-blob.html` (2).
- `xhr/responseurl-after-abort.any.html`,
  `xhr/responseurl-after-abort.any.worker.html` (4 each): headers,
  responseXML and responseURL kept after `abort()`; the abort cause of
  `wpt-xhr-events`.
- `xhr/responsexml-document-properties.htm` (2): responseXML's document
  carries the routed or the first URL after a redirect; the "lastModified"
  subtest's cause is not yet known.
- `xhr/responseXML-xml-scripting-support-disabled.html` (5; 2 of them pass
  natively only on Chrome 156): `Failed to load 'data:...'`, the synchronous
  data: URL cause of `wpt-xhr-events`.

Passing at d600d112 (a worker's synchronous XMLHttpRequest throws on a
network error): `response-body-errors.any.worker.html` (1).

## wpt-xhr-timeout

- `xhr/xmlhttprequest-timeout-overrides.html?timeout overrides load after a delay`,
  `xhr/xmlhttprequest-timeout-overridesexpires.html?timeout set to expired value before load fires`,
  `xhr/xmlhttprequest-timeout-worker-overrides.html?timeout overrides load after a delay`
  (1 each): `load` for `timeout`. Setting `timeout` while the request is in
  flight restarts the timer from now instead of counting from `send()`.
