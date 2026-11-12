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
and seen by the page exactly as natively, by the browser itself. Scripts and
styles reach it too (below), and Trusted Types (below); base-uri,
form-action, sandbox and frame-ancestors do not yet. report-uri and report-to are left out
(the browser would post the proxy's URLs). A report-only policy goes to the
browser as one. A meta's content is replaced by the browser policy for it
(the inject's attribute hook; the page reads its own content back), and it
applies when the meta is inserted, as natively.

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

script-src-elem, script-src-attr, style-src-elem and style-src-attr reach
the browser each for itself (`codeSources`), with the page's keywords,
nonces, hashes and local schemes as written: the browser itself runs or
refuses the page's inline code by 'unsafe-inline' and its nonces, runs what
'strict-dynamic' lets through, and refuses the rest, reporting it as
natively. The proxy's own scripts (the shell, the inject bundle, the
rewriter library, the scripts the inject makes) carry a nonce of the
document's (the worker makes one per document and names it in the shell,
`CSP_FACTS`), which every browser policy names wherever the page's inline
code does not run without a nonce (a nonce turns 'unsafe-inline' off);
where it does, the bundle loads by 'self'. 'self' (every routed script) is
given where the page's list names URLs and decides by nothing else, and
the worker applies the hosts (`hostsApply`); where the list also takes
nonces or hashes, a script the page's policy allows by its host carries
the document's nonce, given by the inject (`codeNonce`). A worker of the
document imports the inject by URL, which the browser's policy names
(importScripts takes no nonce).

The rewrite changes the page's inline code, so the browser's hash of it is
not the page's: the inject hashes the page's own text (`src/sha.ts`, SHA-256,
384 and 512 synchronously) and gives an inline script or style the
document's nonce where every enforced policy of the page's allows it (by a
hash, by a nonce, by 'unsafe-inline') and the browser's copy of one would
not; an external script by its `integrity` likewise. The page reads no
such nonce back (`nonce` is the page's).

script-src (or default-src) itself reaches the browser as the page wrote
it, since everything else it would govern has a directive of its own: it
decides eval, `Function`, string timers and WebAssembly compilation, and
the EvalError and CompileError the browser throws name the page's
directive. Where it refuses code made from a string, the inject makes
none of its own (the browser would report each attempt): the shared
rewriter realm, a frame's library, the host's hooks and the blocker's
scriptlets are made by scripts that carry the document's nonce, the
realm holds the whole rewriter library (the light one would make it from
its text), and a worker imports the library's file. A classic worker of a
`blob:` URL, which inherits the document's policy, cannot import the page's
blob where the policy refuses `blob:` scripts: the page's Blob is the
bootstrap's own text, after its preamble. A violation's `sample`
('report-sample') is the page's code.

## Trusted Types

`require-trusted-types-for` reaches the browser as the page wrote it, and
`trusted-types` with the page's names and one more: the name of the
inject's own policy (`ScriptFacts.tt`, made by the worker for each
document; a meta's comes from the inject), which no page knows. So the
browser refuses a string at every sink as natively, and every sink the
inject does not write for the page (`Document.parseHTMLUnsafe`,
`DOMParser.parseFromString`, `setAttributeNode`, a script element's text
that lands as a Text node) is judged by the browser itself, with the
page's default policy, Chrome's TypeError and a trusted violation.
Policies are made, refused and reported by the browser (the names, 'none',
'allow-duplicates', `*`), and `trustedTypes.defaultPolicy` is the page's.

The inject writes strings into these sinks all the time (the page's
rewritten markup, its rewritten scripts, eval of rewritten code, the
proxy's own scripts and functions): they carry values of its own policy
(`src/inject/trusted.ts`), made in the bundle's realm (a trusted value of
one realm is one in every realm, measured). The Function constructor takes
no trusted value (only a default policy's identical string, measured), so
the inject's own functions are made by eval of a trusted value where
Trusted Types are in use, and a top's rewriter realm holds the rewriter
library itself. A blob: worker inherits its document's policy: its
bootstrap makes the inject's policy and hands importScripts trusted URLs.

Where the inject writes for the page (an innerHTML, a script's text or src,
a handler or srcdoc attribute, document.write, insertAdjacentHTML,
setHTMLUnsafe, createContextualFragment, execCommand, eval, Function, a
string timer, a Worker, a javascript: navigation), it judges the page's
value first, as Chrome does (`src/inject/modules/TrustedTypes.ts`): a
trusted value of the sink's type passes, a string goes to the page's
default policy with Chrome's arguments (the value, the type, the sink's
name: `Element innerHTML`) and what it returns is the value (for eval and
Function only the identical string). What is left is refused by the
browser: the native sink is handed the page's own value, and the default
policy's answer is replayed to it (the page's callbacks are wrapped when it
makes its default policy), so the TypeError or EvalError, the violation and
its sample are Chrome's. A script's text the page set through a sink is
its own; text that reached it otherwise (a Text node, a clone) is judged as
the script runs (`HTMLScriptElement text`), and the inject's rewrite of
text that lands as a Text node is let through by the default policy's
wrapper without asking the page. A report-only policy's refusal of a sink
the inject writes is the inject's event, with Chrome's fields, but not
trusted.

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

A report-only policy's refusal of a load that goes out cannot be made the
browser's without refusing the load: the inject dispatches the violation
itself, with Chrome's fields, as many times as Chrome fires it (a fetch, a
beacon and a frame twice, measured), but not trusted. The worker tells the
document of the ones only it sees (`CSP_REPORT`); the fetch,
XMLHttpRequest, EventSource, beacon and WebSocket hooks report their own.

## What the page reads

`SecurityPolicyViolationEvent`'s getters (`src/inject/dom/modules/ContentSecurity.ts`)
name the page's URLs (documentURI, blockedURI without its fragment,
referrer, sourceFile; the inject's own bundle as no URL) and the page's
policy as it wrote it (originalPolicy); a report body
(`ReportingObserver`) the same (`Unroute`). A fetch or XMLHttpRequest
reads a response's policy headers as natively (the browser applies none
of them to such a response).

## Not yet as natively

- Sandbox, base-uri, form-action and frame-ancestors are not applied.
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
- Under 'strict-dynamic' the inject bundle's script carries the document's
  nonce (nothing else lets it through), and V8 keys a script's compiled
  code by its nonce too: each such document compiles its own copy of the
  bundle (about 770 KB of heap a frame, measured). Elsewhere the bundle
  loads by its URL, which the browser's policy names.
- A frame's navigations other than the src its parent sets (a redirect, a
  navigation the frame starts) are not judged by the parent's frame-src.
- A policy a script inserts as a meta is applied by the browser, but its
  hosts are not (the worker reads the metas of the markup it serves).
- sourceFile, lineNumber and columnNumber of a violation the browser
  reports for a load the inject made on the page's behalf name no script
  of the page's.
- A worker's own policy (its script's response headers) is not applied.
- No report goes to a policy's report-uri or report-to endpoint (the site
  never sees one; the page sees every violation, as natively).
- An `<object>` of a page-made `blob:` URL does not load through the proxy,
  with or without a policy.
