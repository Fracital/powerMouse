# A page's Content-Security-Policy

A proxied page's own policy (its `Content-Security-Policy` and
`Content-Security-Policy-Report-Only` headers, its
`<meta http-equiv="Content-Security-Policy">` elements) refuses and reports
what Chrome refuses and reports for it on the page's real origin. Pages
and bot checks notice a policy that does nothing: Cloudflare's challenge
frame runs `fetch('data:,')` and expects its connect-src to refuse it.

The browser applies a policy to the proxy's URLs, where every proxied
origin is one origin, and it applies it to the proxy's own machinery in the
document (the shell, the inject bundle, the rewriter library, the sealed
copies' worker, the routes the inject asks the service worker on). So the
page's policy is split by what a source names:

| Part of the policy                                                        | Applied by                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| local schemes (`data:`, `blob:`, `filesystem:`, `mediastream:`), `'none'` | the browser, as the page wrote them                                      |
| hosts, `'self'`, `*`, network schemes (`https:`), paths, ports            | the service worker for a request it sees, the inject for one it does not |

Nothing of the policy reaches the browser as the page wrote it: the browser
gets a policy of its own for each of the page's (`src/csp.ts`
`browserPolicy`), and the inject reads every violation back as the page's.

## What the browser gets

For each fetch directive the page's policy governs loads by (connect-src,
img-src, font-src, media-src, object-src, frame-src, fenced-frame-src,
worker-src, manifest-src, each through its fallbacks: default-src,
child-src, script-src for workers), the browser's policy has that
directive with `'self'` (the proxy origin: every routed load and every
request of the proxy's own) and the page's local schemes as written. A
`data:` image, a `blob:` frame or a `fetch('data:,')` is refused, reported
and seen by the page exactly as natively, by the browser itself. base-uri,
form-action, frame-ancestors and sandbox reach it too (Navigations and
Sandbox, below). script-src, style-src and Trusted Types never reach the
browser: it would judge the proxy's shell, the inject bundle and every
rewritten inline script by them too, and a nonce or hash on the real
injected element does not hold on the live proxy origin. The inject enforces
those against the page's own code instead (Scripts and styles, below).
report-uri and report-to are left out (the browser would post the proxy's
URLs): the inject sends a document's reports to its report-uri itself,
and hands those for its report-to to the service worker (Reports, below). A report-only policy goes to the browser as one. A meta's content is
replaced by the browser policy for it (the inject's attribute hook; the page
reads its own content back), and it applies when the meta is inserted, as
natively. A meta outside the head is ignored, as natively: the browser gets
no content for it, and the console says so with the page's policy.

A document of the site pool (docs/site-pool.md) is on a slot's origin, and a
frame or a form of a site another slot shows reaches it by a 307 to that
slot's origin, which the browser judges by its copy of the page's policy.
So the browser's frame-src, fenced-frame-src and form-action (whatever
fallback the page's comes from: child-src, default-src) also name the
pool's slots wherever the page's sources let any URL through. The page's
own policy is still the inject's and the worker's to apply, before the
hop: a frame, a form or a redirect it refuses goes to a refusal URL, which
is on no slot's origin, and what the documents of a navigation told the
worker of its policies and of a frame's ancestors goes on to the next
slot's worker with the navigation. The inject reads a URL the browser
names on another slot's origin as the same route on its own, and one that
is no route there (a bare slot origin) as no URL: a violation never names
a slot.

Each browser policy carries a mark of its own, a scheme source that matches
nothing (`p1a2b3c-0:`), so the inject knows which of the page's policies
the browser reports (two of the page's can come out the same for the
browser). The shell hands the client each header policy's pair
(`policyTexts`).

Where the inject's own machinery needs a local scheme the page refuses, it
takes another way: the response document of an XMLHttpRequest is made from
the service worker's echo route (`ECHO_ROUTE`) instead of a `data:` URL, the
sealed copies' worker comes from the worker's route and asks it whether a
`blob:` URL is gone, and an object's copy (a `blob:` URL in every document)
is let through by the browser wherever the page lets any object load,
while the inject refuses the page's own `blob:` objects.

## Scripts and styles

The browser never gets the page's script-src or style-src, so STomp's own
scripts and styles are never subject to it. The inject enforces them against
the page's own code, from the page's policies the shell hands the client
(`policyTexts`, and the metas the inject sees), as Chrome does (measured,
Chrome 152 and 156; `src/cspJudge.ts` `codeAllows`,
`src/inject/dom/policyChecks.ts`, a deferred part of the document bundle).
A refusal is the inject's own securitypolicyviolation event, dispatched on
the document, with Chrome's fields (the page's policy as its
`originalPolicy`, the page's code as its `sample` under 'report-sample', the
element Chrome names as its `target`); its listeners read it as trusted,
as the browser's is (`trustTaggedViolations`), which the suite does not
compare for scripts and styles.

An inline script (its text) or an inline style runs only where an enforced
policy allows it by 'unsafe-inline', by a nonce the element carries, or by
the hash of the page's own text (`src/sha.ts`, SHA-256, 384 and 512); a
script the page inserts through the DOM runs under 'strict-dynamic', the
parser's and document.write's do not. A refused inline script keeps no text
(it runs nothing); a refused inline style's rules are dropped. An external
script or style by its URL is the service worker's to refuse and report
where it sees the request (`hostsApply`, Hosts below); the inject refuses a
`data:` or `blob:` one itself and fires the enforced violation the worker
cannot. A script the page inserts through the DOM is judged as it connects,
with the nonce it has then, as Chrome judges it as it prepares it: one whose
src the page set before it connected, and that a policy refuses, is held
(no src for the browser; the page reads its own) and judged by the
insertion that connects it (`DocumentClient.holdScript`), whose call its
violation names; one never inserted fires nothing. Any other way it
reaches the document (inserted into another document), it stays held.

A script of the page's markup (the response's, or one document.write
writes) is judged as the parser prepares it, as Chrome judges it, by the
policies the document has then: a meta in the head applies to the scripts
after it, whether it came in the first chunk of the markup, a later one, or
from a script that inserted it, and not to the scripts before it. The copy
of the markup marks each script (`<prefix>parsed`), and a MutationObserver
the inject keeps on the written document judges each marked script the
parser inserts (the parser runs a microtask checkpoint before it runs a
script it inserted, also where the markup waited behind a script that was
loading; `DocumentClient` `#watchParsed`). A script the inject writes in
the markup's place (the stand-in that writes each inline style,
`DOMContentHooks` `rewriteStyle`, kept in `ownScripts`) is not marked: the
browser never sees it, so the page's policy never judges it, and a style
under a policy of nonces stays and applies with no violation. An external
script the policies
in force already refuse as it is copied gets no src there (more policies
refuse no less), and is judged and reported with the others, in the order
the parser prepares them; one after a meta of the head that is not in the
page yet is written with no src for the browser until it is judged, so
that the browser's preload scanner fetches nothing the page's policy
refuses, as natively (`#holdParsed`). A refused inline script keeps no
text; a refused external one keeps `src=""` for the browser, which fires
its error event, as for the refused script natively, and the page reads
its own src back. A violation of an inline script of the markup names
where its text starts, as Chrome's does: the document's URL (no query, no
fragment), the line (its line feeds counted; a carriage return alone ends
none) and the column in UTF-16 units (`./markupPlaces.ts`
`markupScriptSite`, read from the markup the inject received); an external
one's names none, as natively. One the page's code inserts (through the
DOM, by document.write) names the inserting call, as Chrome's does: in a
script file, its place in the file's own text, from the map the service
worker's rewrite of the file carries, and in code the inject rewrote (a
script of the markup, eval, a handler) from the map its rewrite handed
over (`docs/rust-plan.md`, position maps).
The console says what Chrome's says of
each refusal (the page's directive, its notes on 'unsafe-inline' and on
the fallback directive), and
the page's ReportingObservers are handed a csp-violation report of it as the
browser hands its own: takeRecords has it at once, the callback in a task
before the event, a buffered observer the reports before as it first
observes, and the report and its body read as the browser's
(`src/inject/reportsSeen.ts` `madeReport`; csp-meta-scripts compares them).
A document reports a placed violation once, as Chrome does: the same code
refused again at the same place (a script file run twice) fires its event
and makes no second report.

A script-src-attr handler and a style-src-attr style attribute run
only by 'unsafe-inline' (or 'unsafe-hashes' with the value's hash); the
inject clears the live attribute where they do not. Chrome judges a
handler as its attribute is set and again as it compiles it, at its first
run or the first read of its property (`el.onclick`), by the policies in
force each time (a report-only policy reports both), and so does the
inject: one the page's code sets as it sets it, one of the page's markup
as the parser inserts its element in the written page (the copy marks it,
and `#watchParsed` judges it, also after the markup's last script, at
DOMContentLoaded), one a document.write wrote at the write, once the
parser inserted it (`writtenHandlers`), so a meta before it applies. One
that runs before it was judged as parsed (an iframe's load as the parser
inserts it) is judged as parsed first. The rewritten handler asks the
access API's `csp` first (`DocumentClient.codeRuns`, `./policyChecks.ts`
runRefused), which judges it once by the policies then and keeps that
verdict, as the compiled handler is kept: a handler parsed before a meta a
script inserts is refused as it runs. Its property's getter judges it the
same way and reads null where it is refused, and one read before any
policy governs code compiles it, so it runs whatever policy comes, as
natively (`./handlerGetters.ts`: a property's getters, on the few
prototypes that have them, are hooked the first time the inject meets an
attribute of its name in that document, before the element is in it, with
one getter body that finds the name in a table of the native getters;
hooking every handler's in every frame cost some 19 KB a frame, these
about 2 KB in a frame that has a handler attribute and nothing in one
that has none). Its violation as it is compiled names the code that dispatched its
event or read its property, else its place in the markup (where its start
tag ends, where V8 counts the handler's own frame from: the service
worker's, sent with its rewrite, src/prewrite.ts, else found in the page,
`./markupPlaces.ts` handlerPlace; two handlers of one text are two
scripts, each with its own place); as it is parsed,
none, or the write. A javascript: URL is judged at script-src-elem as
Chrome judges it: as its navigation starts, by the policies of the
document whose code started it (a link's click, a location it set, a
form it submitted, a frame's `src` it set, its open()), at that code
(`DocumentClient.jsStarts`, which hands the check to the window it runs
in, or, for a window with no document of the inject's yet, keeps it for
that window to find; another frame's violation targets the frame's
element; the markup's frame and a new window's URL are judged twice there,
as natively), and again as it runs, by its window's, at the document's
first line. The rewritten URL asks `csp` before its code
(`src/rewriteHTML.ts`), and a refusal runs none of it; a report-only
policy reports it twice. A URL the starting document's enforced policies
refuse as it starts goes to a route that only judges it (`routeHTML`
`judged`: a policy only grows, so every navigation the document starts to
it is refused from now), so its code is never compiled and declares
nothing. The violation events and reports of a check made as the
navigation started are dispatched before the code runs, as natively, also
where the code runs before that check's own task (a frame's, a form's). One of statements has the call after its
directive prologue, and the rest stays the script's own (its `let` and
`const` the window's, its value the URL's): a refusal throws what the
inject's own error listener takes before any of the page's. Under
`require-trusted-types-for 'script'` the code then goes to the page's
default policy (`Location href`), and what it returns runs instead; with
none, or null, the navigation is refused (report-only: reported) with
Chrome's console message. Their console messages are Chrome's ("Executing
inline event handler", "Running the JavaScript URL", with no hash). A CSSOM write (an
element's `style` property, `setProperty`) is the browser's to allow, so the
inject does not refuse it, only the `style` attribute the page sets as a
string.

script-src (or default-src) decides eval, `Function`, a string timer and
WebAssembly compilation: without 'unsafe-eval' (or 'wasm-unsafe-eval', which
allows only WebAssembly) the inject throws Chrome's EvalError or CompileError
naming the page's directive, runs nothing, and reports it; a string timer
runs nothing and throws nothing. The violation names the page's call, as
Chrome's does (sourceFile, lineNumber, columnNumber): in a script file, in
a script of the markup (the document's lines, its first line's column
from where its text starts) or in a handler (from where its start tag
ends), read through the map of the rewrite of the code that made the call
(`docs/rust-plan.md`, position maps). STomp's own code is never refused: it evals
through the realm's own `eval` captured before the page's, and its wasm
compiles with native `WebAssembly` methods captured before the inject's wrap
(`src/wasm/module.ts`), so the page's policy never reaches it.

## Trusted Types

The browser never gets `require-trusted-types-for` or `trusted-types`: it
would refuse the proxy's own `Function`, eval and HTML/script sinks, and
STomp's own policy would have to cover every write STomp makes into a sink,
which is what blocked the inject on strict sites. The inject's own policy
never activates (`src/inject/trusted.ts` `name` stays null). So the inject
enforces the page's Trusted Types against the page's own sinks and policy
names itself, as Chrome does (measured, Chrome 152 and 156;
`src/inject/modules/TrustedTypes.ts`), wherever the page's policy carries a
Trusted Types directive (`ScriptFacts.ttActive`, from `src/csp.ts`).

A trusted value of the sink's type passes as its own string; a string is
handed to the page's default policy with Chrome's arguments (the sink name,
the type), and what it returns is the value (for eval and `Function` only an
identical string runs). What is left is refused with Chrome's own per-sink
TypeError (the `require-trusted-types-for 'script'` sinks: innerHTML, a
script's text, `eval`, a string timer, a javascript: URL, a worker URL, and
the parser sinks) and a trusted-types-sink violation; the message gains its
tail when a default policy exists but returned null or does not cover the
type. A `createPolicy` the `trusted-types` directive refuses (a disallowed or
duplicate name) throws Chrome's TypeError and reports a trusted-types-policy
violation. Under a report-only policy the sink goes on with the page's value
and the inject reports it; its listeners read the violation as trusted.

An enforced Trusted Types violation is the browser's own to the page, which
compares `isTrusted`: the browser never gets the directive, so the inject
synthesises the event, as it does every violation it fires. `isTrusted` is
an own, non-configurable accessor Chrome puts on every event, so it cannot
be set on the event: each listener of the dispatch (a function, an object's
`handleEvent`, the document's and the window's `on` handler) is handed one
view of it that reads it true, which `window.event` reads too, and whose
other members are the event's and the prototype's own
(`src/inject/violationDispatch.ts`).
A violation in a document the browser made of its creator's (about:blank,
srcdoc) names, as Chrome's report strips it, the bare scheme (`about`) with
status 0, not the page's URL. STomp's own DOM writes, parses and worker loads
never reach a sink: they go through native sink setters and a native
`DOMParser` captured before the inject's wraps (`src/inject/dom/cloneNode.ts`,
`src/inject/dom/modules/TrustedParse.ts`), so the page's Trusted Types never
reach them.

## Hosts

The service worker keeps each document's policies (header and the metas in
its head) by the routed URL it served it at and by its client id
(`src/server/contentPolicies.ts`); a document of its creator's (srcdoc,
about:blank) is found by its referrer. A request whose real URL a policy of
its document refuses, for the directive of its destination, is answered
with a redirect to `REFUSED_URL`, which every browser policy refuses: the
browser refuses the load as natively (fetch rejects, an image fires error)
and reports it itself, naming the first URL of the chain, the route, which
the inject reads back as the page's URL. The violation is the browser's,
trusted and dispatched where natively.

What no worker sees is refused by the inject the same way, with a URL of
its own the browser refuses (`refusalURL`, `https://r<n>.refused.invalid/`),
which the violation names and the inject reads back: a frame's src
(frame-src; another origin is named by its origin, as Chrome names a
refused navigation), an object's or embed's data (object-src), a
WebSocket (connect-src; it errors and never closes, as natively).

The browser reports a refusal against each of its policies that refuses
the URL it was given, so a page policy that allows the real URL would see
another's refusal: the inject listens first, at the window's capture, and
stops a violation whose page policy allows the URL natively (a refused
route is still shown when no enforced policy refuses it: a later hop of a
redirect, which Chrome names by its first URL).

A worker's requests are judged by the worker's own policies, as Chrome
judges them (measured, Chrome 157): a worker of a URL (dedicated, module,
shared, or a page's service worker) has its script's response's
policies, never its document's; a `blob:` or `data:` worker has its
creator's, each with its creator's 'self'. Its fetches, XMLHttpRequests,
EventSources, WebSockets and WebTransport sessions by connect-src, its
importScripts and `import()` by script-src-elem, its own workers by
worker-src; a module worker's static imports by its creator's
script-src-elem (they load before the worker has a policy). The browser
applies none of them to the proxy's URLs (the worker's policy headers
are dropped like any response's), so the worker's client is handed them:
the route's preamble names those of a worker's own script
(`judgeConnections`; a module the worker imports is a `cors` request and
names none), an emulated service worker's are kept with its script, and
a `blob:` worker's bootstrap or a `data:` worker's rewrite names its
creator's (`connectInheritance`).

The worker's inject judges each request as the page's code makes it
(`requestVerdict`): only it sees a socket, a session, a `data:` or `blob:`
URL, and a worker's own worker, and only it knows which API made a
request, which decides the violation. A request one refuses goes to the
`refused` route instead, which the service worker answers with a network
error, so the browser fails it with its own error (fetch rejects with
"TypeError: Failed to fetch", an XMLHttpRequest fires error, a sync one
throws NetworkError, importScripts throws NetworkError and `import()`
rejects, each naming the page's URL; a worker fires error); an
EventSource's route answers 204, which fails its connection without a
reconnect, as natively. A socket fires error and no close; a session's
`ready` and `closed` reject with Chrome's WebTransportError. The worker's
global gets one event for each policy that refuses it, report-only ones
too, a task later (twice for a fetch or an importScripts only a
report-only policy refuses, as Chrome): Chrome's fields (the worker's URL
as its documentURI, the place of the page's code that made the request
as its sourceFile (its script's URL without the query, `blob` or `data`
for those), lineNumber and columnNumber, none for an EventSource, a local
scheme's URL as its scheme, status 0, no referrer). The policy's
report-uri gets its report (Reports). The event is the inject's; its listeners
read it as trusted, as the browser's is (`trustTaggedViolations`, as for
Trusted Types). The document hears nothing of it, natively either
(csp-workers, csp-worker-requests).

The service worker keeps each worker's own policies by its client id as
it serves the worker's script (a `blob:` worker's are its creator's), and
refuses what the inject did not: a redirect's hop, a module worker's
static import, a request of a module's top level before the worker was
handed its policies. A worker's refused request is answered with a
network error, not `REFUSED_URL`: a `blob:` worker's realm has its
document's browser policies, whose violations would name the proxy. The
inject stops those at the worker's global, before the page's listeners
(the worker reports its requests itself).

A report-only policy's refusal of a load that goes out cannot be made the
browser's without refusing the load: the inject dispatches the violation
itself, with Chrome's fields, as many times as Chrome fires it (a fetch, a
beacon and a frame twice, measured), which its listeners read as trusted,
as the browser's (csp-base-uri compares it). The worker tells the
document of the ones only it sees (`CSP_REPORT`); the fetch,
XMLHttpRequest, EventSource, beacon and WebSocket hooks report their own.

## Navigations

base-uri and form-action reach the browser as the fetch directives do,
with `'self'` and the page's other schemes (`'none'` as written), with no
fallback: default-src governs neither, natively (base-uri also with the
document's own origin, below). A javascript: or mailto: action names no
host, and the browser refuses it as natively (even under `form-action *`).

- **base-uri.** A `<base>` whose real URL the page's enforced policy
  refuses (its headers', its metas', the metas before it in the markup
  being rewritten) gets a refusal URL as its href. The browser refuses it,
  the document's URL stays the base URL, and the browser's events are
  Chrome's, as many as Chrome fires (every insertion of a base checks the
  first one again). A base the markup rewrite reads (loadHTML's base URL)
  is the document's URL then. A report-only refusal is the inject's
  event: once, for the first base, a task after the hook (for the markup's
  own base, at DOMContentLoaded). A base the page allows keeps its real URL
  for a moment while the inject routes it to the proxy origin, and the
  browser judges that write: so base-uri reaches the browser with the
  document's own origin as a host source besides `'self'` wherever the
  page's base-uri allows the document's origin (`browserPolicy`), so the
  browser accepts the page's own base as natively (the proxied route is the
  proxy origin, `'self'`; a refused base's refusal URL is on
  `refused.invalid`, which the real origin never matches). A base-uri
  violation of a base the hooks wrote for a moment with the page's own URL,
  where that origin is not the browser's base-uri (a cross-origin base the
  page allows), is stopped.
- **form-action.** A submission (a submit event, at the window's capture,
  or `submit()`) whose URL the page's enforced policy refuses goes to a
  refusal URL: the element's action (or the submitter's formaction) is
  that URL until the next task (to the end of `submit()`). The browser
  refuses it before anything is sent, opens no window for `_blank`, and
  reports it with the form's query, as natively. The refusal is the
  submitting document's own: a frame that submits to a refusal URL is not
  given a fresh browsing context for it (`freshContext.ts`, which would make
  the navigation its parent's, a plain load no form-action judges), its
  navigate event names the URL the page submitted to (`Readback`), and a
  frame still on its initial about:blank that a refused form is aimed at
  keeps its context. A form aimed at a proxied parent or top (Sandbox) is
  left to the browser when refused. The document tells the worker its
  form-action with the navigation's hint, and the worker judges every later
  hop of the chain by it (paths not compared): a hop it refuses is
  redirected to `REFUSED_URL`, which the browser refuses and reports by the
  chain's first URL, as Chrome does. A report-only refusal is the inject's
  event, the worker's for a hop (CSP_REPORT).
- **A frame's navigations.** Natively the parent's frame-src judges every
  navigation of a frame and every hop. The src a parent sets the parent
  judges (above). A navigation of the frame's own, or one another document
  starts in it, its document judges in its navigate event by its parent's
  policies: a refused one is cancelled and goes to a refusal URL of the
  parent's, which the parent's browser frame-src refuses (the frame shows
  the error page, the parent gets Chrome's event). The page's own navigate
  listeners hear of a refused one once, when it goes to the refusal URL,
  whose destination reads as the URL they named. A navigation to another
  origin is judged before the frame gets its fresh browsing context
  (`freshContext.ts`: the guard asks `NavigationHint`), and a refusal URL
  never gets one. Both documents tell the worker the parent's frame-src
  with the navigation's hint, and a hop it refuses goes to a URL whose host
  names the refused URL (`namedRefusal`): Chrome names a refused navigation
  by the URL refused, its origin alone for another origin than the
  parent's, and the inject reads the host back. A hop to another origin
  that a policy of the chain refuses is refused in the context the
  navigation is in, before the worker would answer the redirect with the
  document that asks for a fresh context (`src/freshFrame.ts`).
- **frame-ancestors.** A framed document's own frame-ancestors (headers
  only; a meta's is ignored, natively) is judged against the real origins
  of its ancestors, the proxied top the outermost (the host's page is no
  ancestor a page knows of natively, and the proxy's own
  `frame-ancestors 'self' <host origins>` stays). The document that
  navigates the frame tells the worker the ancestors with the hint; without
  one, the top the route names is the only ancestor. A refused document
  gets `frame-ancestors 'none'` besides: the browser shows its error page
  as natively (one load event, no document, no event anywhere).
- **upgrade-insecure-requests** is applied by the worker from an enforced
  header or a meta in the markup's head, and not from a report-only policy,
  as natively (mixed-content suite).
- **navigate-to** is not implemented in Chrome, and does nothing here.

## What the page reads

`SecurityPolicyViolationEvent`'s getters (`src/inject/dom/modules/ContentSecurity.ts`)
name the page's URLs (documentURI, blockedURI without its fragment,
sourceFile; the inject's own bundle as no URL), the document's referrer
as the page reads it and the page's
policy as it wrote it (originalPolicy). A base-uri or form-action
violation, the browser's (which names the inject's hook, or the shell's
markup) or the inject's (which names nothing), names where Chrome does: the
page's script that set or inserted the base or submitted the form, without
its query, and the position of the call, the markup's base by the
document's URL and the line and column after its start tag, and nothing
for a form into a new window; the place is noted where the hook runs and
read back by the violation (`src/inject/dom/violations.ts`, a deferred
part). A report body
(`ReportingObserver`) the same (`Unroute`). A fetch or XMLHttpRequest
reads a response's policy headers as natively (the browser applies none
of them to such a response).

## Reports

A document's policy's report-uri gets what Chrome sends it (measured,
Chrome 157), for the inject's violations as they are made
(`policyChecks.ts` makeReport) and for the browser's as the page sees them
(`violations.ts` violationShows): one POST of `application/csp-report`
(`{"csp-report": {...}}`, Chrome's members in its order, the place only
where there is one) to each endpoint, at once, none again for a report
that reads as one the document sent, and none where the policy has
report-to. It is a request of the document's
(`src/inject/dom/violationDelivery.ts`, a deferred part) the service
worker sends as a `report` load (Sec-Fetch-Dest: report, no-cors), with
the cookies of an endpoint of the document's origin only and the Referer
the document's policy gives it. csp-scripts compares what the fixture's
endpoint receives, of its origin and of another.

A worker's policy's report-uri gets what Chrome sends it too (measured,
Chrome 157): the same POST of `application/csp-report` as the violation
is made (Sec-Fetch-Dest: report, no-cors), the worker's URL as its
Referer and its document-uri, the place of the page's code in the
worker's script, once per report that reads the same (a fetch only a
report-only policy refuses fires two events and sends one report). The
worker's inject sends it (`WorkerClient.requestVerdict`), with no load
channel to announce it on: it names `WORKER_REPORT_LOAD` in the load
header, and the service worker sends it as a `report no-cors` load only
where the requesting worker's own policy (a `blob:` worker's creator's)
is the report's original-policy and names that endpoint in its
report-uri, and the body is a `csp-report` of Chrome's members
(`contentPolicies.ts` workerReportAllowed): a worker's script can make
no request that way that a violation of its policy does not send
natively. csp-worker-requests compares what the fixture's endpoint
receives from a dedicated and a shared worker.

A policy's report-to sends to the endpoint its first token names in the
document's Reporting-Endpoints (an https document's only, an endpoint of
a potentially trustworthy URL only; the legacy Report-To header's groups
are none, as natively). The service worker reads the header with the
document's response (`src/server/reportUploads.ts` reportingEndpoints,
into its ScriptFacts) and the shell gives the client them as `reportTo`
(`src/htmlShell.ts` reportEndpoints). The inject hands each report (once
per document, the place only where there is one) to the service worker as
a `reports` load, and the worker delivers it as Chrome's Reporting API
does (measured, Chrome 157): the first report at once, the ones queued
after it together about a minute after the last upload, or at once when
their document is gone (the worker looks for the documents of waiting
reports every second, `clients.get`); each document's reports for one
endpoint in one POST of `application/reports+json` (a list of `{age,
body, type, url, user_agent}`, every member in alphabetical order), with
Origin, User-Agent and Accept-Language and no Referer or Sec-Fetch-
headers; an endpoint of another origin asked first by a CORS preflight
(each upload, no cache) and sent no cookies, one of the document's origin
sent them. A report outlives its document (the fetch event that handed it
over waits until it is delivered), and one that failed goes with the next
upload, up to five times. csp-reports compares what the endpoints of an
https fixture receive, natively and in both modes.

## Sandbox

A header policy's `sandbox` directive sandboxes its document as a frame's
`sandbox` attribute does (several policies' directives narrow each other,
and a frame's attribute narrows them all); a meta's and a report-only
policy's are ignored, as natively. It reaches the browser the way the
attribute does (`realSandbox`): as a policy of its own with the page's
flags but the top navigation ones, and with allow-same-origin and
allow-scripts, which the service worker and the inject need (an opaque
origin's navigations never reach the worker, and the inject rewrites the
document). So the browser itself refuses modal dialogs, forms, popups,
downloads and pointer lock where the page's flags do, and a popup or a
frame inherits them. The rest is the inject's, from the flags the shell's
`policyTexts` carry (`DocumentClient.sandboxFlags`, decided again when
the shell sets them, before the page runs): the opaque origin
(`self.origin` "null", storage, cookies, IndexedDB and Cache Storage
refused, its frames and popups of another origin), the scripts that do not
run (the nonce policy of `src/inject/dom/sandbox.ts`), the windows it may
navigate, and `document.domain`, whose setter throws in any sandboxed
document and whose getter reads `""` in an opaque one. Nothing a sandbox
refuses fires a violation, natively either.

## Not yet as natively

- Trusted Types: the browser reports a report-only refusal of a script
  whose text landed as a Text node with the rewrite as the sample. A
  worker judges no
  importScripts of the page's and reports no report-only refusal, and a
  module worker of a `blob:` URL does not start. An SVG script's
  rewritten text is let through only by a default policy, as the page's
  own would be. A violation's sourceFile is not the page's script.
- An external script after a meta a script inserts is not fetched; Chrome's
  preload scanner, which does not know the meta, fetches it (and does not
  run it).
- A report-only refusal of a load that went out (an image, a fetch: the
  worker's word, after the load) is reported, event and report, with no
  place, and without Chrome's console message; Chrome names where the
  parser was or the calling code.
- 'unsafe-hashes' with the hash of an event handler, a style attribute or a
  `javascript:` URL: the rewrite changes the text, and the browser refuses
  it.
- A javascript: URL of statements refused only as it runs (another
  window's location set to it, which the setting document does not
  judge; a markup frame's src parsed before a meta) has compiled before
  its check refuses it (the check is its first call): a `let`, `const` or
  `class` it declares is the window's, never initialized (`typeof`
  throws, a later declaration of the name is a SyntaxError); natively
  there is none. A link or form whose URL went to the judging route keeps
  it: moved to a document that allows the code, it still runs none.
- A javascript: URL whose code a Trusted Types default policy changes runs
  the changed code one task later than natively (it goes through a
  navigation of its own).
- A stylesheet `<link>` the page's policy refuses keeps no href, so its
  `sheet` is null; natively it is an empty sheet (csp-scripts lists it as
  an expected difference).
- A module worker of a `blob:` URL under a policy that refuses `blob:`
  scripts does not start (its bootstrap imports the page's module).
- A report-only policy does not report an inline script an enforced one
  allows by its hash.
- A script the page's code gave a refused src before it connected (held,
  above) has no src for the browser: a copy of it (cloneNode, importNode, a
  template's content) loads nothing and fires no event, where natively each
  is judged again as it connects. A script of another document is judged
  as its src is set there (its violation names that call), so a nonce it
  is given later does not count when it is adopted, and it loads nothing
  (csp-scripts lists these as expected differences).
- A frame under a script policy the inject enforces (nonces,
  'strict-dynamic') costs about 15 KB of heap more than under none: its
  checks' deferred part, evaluated in each such frame (frame-cost gates a
  'strict-dynamic' frame). The bundle loads by its URL there as anywhere
  (the browser gets no script policy of the page's), so its compiled code
  is shared.
- A sandbox's console messages name the proxy's URLs (a refused form's,
  a refused popup's), and a meta's or a report-only policy's `sandbox`
  is ignored without Chrome's console error for it. An external script of
  a document without allow-scripts is not fetched (natively it is, and
  not run).
- A form a frame submits to a URL its parent's frame-src refuses: the
  navigate event the frame's own listeners get is that of the navigation
  made again to the refusal URL (the browser refuses a navigation only
  where it goes to a URL its copy of the policy refuses), which is no form
  submission: its `formData` is null, natively the form's (csp-navigation
  lists it as an expected difference).
- A report-only refusal of a frame's own navigation is the inject's event,
  with no source position; a same-frame one may go with the document, as
  natively it may.
- Where a violation says its code was (sourceFile, lineNumber,
  columnNumber) is as natively for base-uri and form-action only, and for
  those not where a page's inline script made it (its position is that of
  the document the inject writes), for a form whose action is
  javascript: or mailto:, for a form whose target names a window that does
  not exist yet or that a `<base target>` sends to a new one (named as a
  form into its own window), or for a base set and inserted again within
  one task with the same URL (the last place is named). Every other
  directive's violation is not placed as natively, but for an inline
  script of the markup's or one a script file inserts: the inject's own
  (the page's code it refuses under script-src-attr, style-src or Trusted
  Types, a report-only refusal of a load) names no place, and the
  browser's names
  the line and column of the inject's hook, with no sourceFile, where a
  hook made the load (a frame, an image, a worker, a connection).
- A navigation's hop refused by one of two policies is reported by both
  (the browser refuses `REFUSED_URL` under every policy it has).
- A history traversal of a frame is not judged by its parent's frame-src;
  a frame on its initial about:blank that a link or form of another
  document navigates tells the worker no ancestors (its top is the one
  judged).
- frame-ancestors applies to HTML and XML documents only; X-Frame-Options
  is still dropped.
- A meta with upgrade-insecure-requests that a script inserts does not
  upgrade anything.
- A policy a script inserts as a meta is applied by the browser, but its
  hosts are not (the worker reads the metas of the markup it serves).
- sourceFile, lineNumber and columnNumber of a violation the browser
  reports for a load the inject made on the page's behalf name no script
  of the page's.
- A worker's request its own policy refuses at a redirect's hop is
  refused (or, report-only, let out) by the service worker, but fires no
  violation: the service worker cannot reach the worker's global
  (csp-worker-requests lists it as an expected difference). A module
  worker's own policy reaches its inject once its script's body starts, so
  what a module it imports connects to at its top level is refused by the
  service worker without a violation. A worker's script list that takes
  nonces, hashes or 'strict-dynamic' judges none of its imports. A
  `data:` worker's violation names no place (lineNumber and columnNumber
  0: its realm tells none of its frames from the inject's), and a `blob:`
  worker's import() violation names the column the rewrite of the call
  maps to, natively its specifier's (csp-workers and csp-worker-requests
  list them).
- An `<object>` of a page-made `blob:` URL does not load through the proxy,
  with or without a policy.
