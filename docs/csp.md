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
styles are not among them yet (the shell and every rewritten inline script
would be judged too); neither are base-uri, form-action, frame-ancestors
or Trusted Types (sandbox has a section of its own). report-uri and report-to are left out
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

- Scripts and styles (script-src, style-src and their -elem and -attr
  forms, nonces, hashes, `'strict-dynamic'`, `'unsafe-eval'`), Trusted
  Types, base-uri, form-action and frame-ancestors are not applied.
- A sandbox's console messages name the proxy's URLs (a refused form's,
  a refused popup's), and a meta's or a report-only policy's `sandbox`
  is ignored without Chrome's console error for it. An external script of
  a document without allow-scripts is not fetched (natively it is, and
  not run).
- A frame's navigations other than the src its parent sets (a redirect, a
  navigation the frame starts) are not judged by the parent's frame-src.
- A policy a script inserts as a meta is applied by the browser, but its
  hosts are not (the worker reads the metas of the markup it serves).
- sourceFile, lineNumber and columnNumber of a violation the browser
  reports for a load the inject made on the page's behalf name no script
  of the page's.
- A worker's own policy (its script's response headers) is not applied.
- An `<object>` of a page-made `blob:` URL does not load through the proxy,
  with or without a policy.
