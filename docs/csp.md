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
URLs). A report-only policy goes to the browser as one. A meta's content is
replaced by the browser policy for it (the inject's attribute hook; the page
reads its own content back), and it applies when the meta is inserted, as
natively.

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
Chrome 152 and 156; `src/csp.ts` `codeAllows`, `src/inject/dom/Client.ts`).
A refusal is the inject's own securitypolicyviolation event, dispatched on
the document, with Chrome's fields (the page's policy as its
`originalPolicy`, the page's code as its `sample` under 'report-sample', the
element Chrome names as its `target`); it is not trusted, which the suite
does not compare for scripts and styles.

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
src the page set before it connected, and that a nonce could still let
through, is held refused (no src) and judged again by the insertion that
connects it (`DocumentClient.holdScript`); any other way it reaches the
document, it stays refused. A script-src-attr handler and a style-src-attr style attribute run
only by 'unsafe-inline' (or 'unsafe-hashes' with the value's hash); the
inject clears the live attribute where they do not. A CSSOM write (an
element's `style` property, `setProperty`) is the browser's to allow, so the
inject does not refuse it, only the `style` attribute the page sets as a
string.

script-src (or default-src) decides eval, `Function`, a string timer and
WebAssembly compilation: without 'unsafe-eval' (or 'wasm-unsafe-eval', which
allows only WebAssembly) the inject throws Chrome's EvalError or CompileError
naming the page's directive, runs nothing, and reports it; a string timer
runs nothing and throws nothing. STomp's own code is never refused: it evals
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
and the inject reports it; the violation is not trusted.

An enforced Trusted Types violation is the browser's own to the page, which
compares `isTrusted`: the browser never gets the directive, so the inject
synthesises the event and tags it (`trustedViolations`). `isTrusted` is an
own, non-configurable accessor Chrome puts on every event, so it cannot be
set on the event; the ContentSecurity module hands the page's
securitypolicyviolation listeners a view that reads it true for a tagged one.
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
as its documentURI and, without its query, as its sourceFile, none for
an EventSource, `blob` or `data` for those, a local scheme's URL as its
scheme, status 0, no referrer). The event is the inject's; its listeners
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
beacon and a frame twice, measured), but not trusted. The worker tells the
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
referrer, sourceFile; the inject's own bundle as no URL) and the page's
policy as it wrote it (originalPolicy); a report body
(`ReportingObserver`) the same (`Unroute`). A fetch or XMLHttpRequest
reads a response's policy headers as natively (the browser applies none
of them to such a response).

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

- Trusted Types: a report-only policy's violation of a sink the inject
  writes is not trusted and reaches no `ReportingObserver`, and the
  browser reports a report-only refusal of a script whose text landed as
  a Text node, or of a javascript: URL, with the rewrite as the sample.
  A javascript: URL of a link (its href is rewritten when it is set) is
  judged by the browser with the rewrite's code: the default policy is
  handed it, and a refusal's sample is it. A worker judges no
  importScripts of the page's and reports no report-only refusal, and a
  module worker of a `blob:` URL does not start. An SVG script's
  rewritten text is let through only by a default policy, as the page's
  own would be. A violation's sourceFile is not the page's script.
- 'unsafe-hashes' with the hash of an event handler, a style attribute or a
  `javascript:` URL: the rewrite changes the text, and the browser refuses
  it.
- A stylesheet `<link>` the page's policy allows by its host where the
  list also takes nonces is refused.
- A module worker of a `blob:` URL under a policy that refuses `blob:`
  scripts does not start (its bootstrap imports the page's module).
- A report-only policy does not report an inline script an enforced one
  allows by its hash.
- A refused external script keeps no src: its markup read back (and
  written, as by document.write), a copy of it (cloneNode, importNode, a
  template's content), and the script itself once it connects load nothing
  and fire no event, where natively each is judged again as it connects. A
  script of another document is judged as its src is set there, so a nonce
  it is given later does not count when it is adopted (csp-scripts lists
  these as expected differences).
- Under 'strict-dynamic' the inject bundle's script carries the document's
  nonce (nothing else lets it through), and V8 keys a script's compiled
  code by its nonce too: each such document compiles its own copy of the
  bundle (about 770 KB of heap a frame, measured). Elsewhere the bundle
  loads by its URL, which the browser's policy names.
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
- A report-only base-uri or form-action refusal, and one of a frame's own
  navigation, is the inject's event (untrusted, no source position); a
  same-frame one may go with the document, as natively it may.
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
  worker's violation's lineNumber and columnNumber are 0, and its
  sourceFile is the worker's script even for a script it imported.
- No report goes to a policy's report-uri or report-to endpoint, a
  document's or a worker's (the site never sees one; the page sees every
  violation, as natively; csp-worker-requests lists a worker's as an
  expected difference).
- An `<object>` of a page-made `blob:` URL does not load through the proxy,
  with or without a policy.
