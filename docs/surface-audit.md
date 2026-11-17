# Surface audit: every web platform feature, classified against STomp

The goal is a complete, checked answer to one question for every feature a page
can reach: **does it matter to a proxy that rewrites URLs and emulates origins
on one real origin, and if it does, does STomp handle it as natively?** A
feature either has a reason to be out of scope, or it has a hook (or a reason
it needs none) and a native-vs-proxied test. Nothing is left unexamined.

This is a linear plan: each phase ends in an artifact the next one reads, and
nothing later is started before the phase before it is done. Work lives in
`~/.claude/stomp-work/surface-audit/` (data, tools, batches) until a phase's
artifact is ready to commit under `test/surface/`.

## Size (measured 2026-11-17)

| Source                                                                     | Entries        | Shipped in Chrome |
| -------------------------------------------------------------------------- | -------------- | ----------------- |
| MDN browser-compat-data `api` (interfaces, members, events)                | 10,325         | 9,366             |
| BCD `javascript` (builtins, syntax, operators, statements)                 | 1,402          | 1,370             |
| BCD `html` (elements, attributes, global attributes)                       | 845            | 775               |
| BCD `http` (headers, CSP directives, methods, status)                      | 421            | 398               |
| BCD `css` (properties, at-rules, functions, selectors)                     | 4,317          | 3,996             |
| BCD `svg` + `mathml`                                                       | 608            | 515               |
| BCD `webassembly`                                                          | 342            | 334               |
| W3C webref IDL: 348 specs, 2,816 interfaces/mixins/namespaces/dictionaries | 11,721 members |                   |
| webref elements                                                            | 312 elements   |                   |

About 17,000 shipped features before Chrome's runtime-only surface (members
that exist in Chrome 157 but in no spec or BCD entry) and the JavaScript
language's syntax features (test262's feature flags). STomp installs about 600
wrappers per frame today.

## Classification

Every entry gets exactly one primary class (and any secondary ones):

| Class | Meaning                                                            | Examples                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-in  | takes a URL that must be routed                                    | fetch, src/href/action/srcset/poster, CSS url(), import(), Worker, WebSocket, sendBeacon, Location setters, pushState                                                                        |
| U-out | reveals a URL or origin that must read as the page's               | location reads, document.URL, referrer, baseURI, Response.url, PerformanceEntry.name, error stacks, MessageEvent.origin, StorageEvent.url, CSP and Reporting reports                         |
| O     | an origin or site boundary the proxy must emulate                  | window references, postMessage, document.domain, opener, cookies, storage, BroadcastChannel, SharedWorker, locks, IndexedDB, CacheStorage, permissions, credentials, partitioning            |
| X     | runs code or markup that must be rewritten                         | eval, Function, string timers, script elements, event handler attributes, markup sinks, javascript: URLs, worklets, import maps                                                              |
| N     | opens a network path or side channel outside fetch                 | WebRTC, WebTransport, prefetch/prerender, Speculation Rules, ping, Beacon, DNS prefetch, Topics, Private State Tokens                                                                        |
| V     | navigates, opens or moves a browsing context                       | window.open, Navigation API, forms, targets, downloads, history, fenced frames, portals                                                                                                      |
| F     | fidelity only: a page can tell it is proxied                       | toString of hooks, descriptors, property order, error messages, stack shapes, timing, feature presence                                                                                       |
| J     | a JavaScript language feature the rewriter must handle             | with, direct eval, import.meta, dynamic import, destructuring, spread/rest, optional chaining, tagged templates, class fields, private names, labels, ASI, Proxy/Reflect, Symbol.unscopables |
| S     | self-contained: no URL, origin, code, network or navigation effect | Math, typed array arithmetic, Intl, most CSSOM computation, WebGL drawing, Web Audio graphs, string methods                                                                                  |

S needs a one-line reason, and it is the only class that ends the work for an
entry. A class S entry that holds or returns another object (a Response, an
element, a window) is not S: the object it hands out is classified on its own.

Each entry's record:

```
{ id, source, path, kind, spec, chrome, class, secondary, reason,
  stomp: hooked | rewritten | routed | not-needed | missing | unknown,
  test: [suite, check] | null, gap: none | fidelity | leak | escape, notes }
```

## Phases

### 1. Inventory (deterministic, one agent)

Merge BCD (`api`, `javascript`, `html`, `http`, `css`, `svg`, `mathml`,
`webassembly`), webref IDL (members with their types, extended attributes and
the interface each lands on), webref elements, and a runtime enumeration of
Chrome 157's every global, prototype and own property (the walker
`test/pages/realm-walker.js` already does this, in every realm kind:
window, frames, workers, worklets). Key every entry by its path
(`api.Element.setHTMLUnsafe`, `html.elements.img.srcset`, `css.properties.mask-image`),
mark each by where it was seen. Add test262's feature flags for the language.
Artifact: `inventory.jsonl`, one entry per line, plus counts by source.

### 2. What STomp touches (deterministic, one agent)

Derive the hook set from the running inject, not from reading code: walk a
native realm and a proxied realm of the same page and record every path whose
descriptor, function identity or prototype chain differs (realm-surface's
walk, kept as data instead of a pass/fail). Add what the service worker
rewrites (HTML attributes, CSS url() and @import, headers, script and module
rewriting) from `src/server` and the rewriter's own tables. Join it to the
inventory: each entry gets `stomp` = hooked, rewritten, routed or nothing.
Artifact: `touched.jsonl` and the inventory with `stomp` filled.

### 3. Rule classification (deterministic, one agent)

Classify what rules can decide from the IDL and BCD alone, and leave the rest
`unknown`:

- an attribute or argument typed USVString/DOMString and named or documented as
  a URL (url, href, src, action, formAction, poster, data, codebase, cite,
  background, ping, manifest, srcset, imageSrcset) is U-in; reflected content
  attributes of the same names likewise;
- EventHandler attributes are X (handler attribute) and F;
- a member returning a URL-named string, a Location or a Response is U-out;
- a member on Window, WindowProxy, Document.domain/cookie, Storage,
  BroadcastChannel, MessagePort, postMessage is O;
- markup sinks (innerHTML family, insertAdjacentHTML, setHTML*, the 157
  members, document.write, Range.createContextualFragment,
  DOMParser.parseFromString) are X;
- whole namespaces with no outward effect (Math, Atomics, Intl, typed array
  prototypes, CSSNumericValue arithmetic, WebGL drawing entry points,
  AudioNode graph members) are S, each family with its reason;
- CSS properties that take `<url>` or `<image>` (from @webref/css syntax) are
  U-in; the rest are S.

Every rule lists the entries it decided, so a wrong rule is found by its
victims. Artifact: classified inventory with `class` filled where a rule
decided, and the remaining `unknown` count, which sizes phase 4.

### 4. Fan-out classification (many agents)

The `unknown` entries go out in batches of about 200, grouped by interface or
spec so an agent reads one spec's semantics once. Each batch agent fills the
record (class, reason, STomp status from phase 2, whether a test covers it,
gap severity) from the spec and MDN text, and measures in Chrome 157 when the
spec is unclear. Every non-S verdict and a 10% sample of S verdicts go to a
second, adversarial agent that tries to show a URL, origin, code or network
effect the first missed (the default is to suspect S). Disagreements are
measured, not argued. Expected size: what phase 3 leaves, probably 4,000 to
7,000 entries, so 20 to 35 batch agents plus verifiers, run as one Workflow in
waves.
Artifact: `classified.jsonl`, every entry with a class and a reason.

Measured size (2026-11-17): 6,183 shipped `unknown` entries in 32 batches, a
classifier and a verifier each, so 64 agents. The 3,461 unknown entries Chrome
does not ship wait until it does.

### 4b. Rule-decided entries (many agents)

A rule decides a class, never STomp's status, a test or a gap. So the 5,851
shipped entries that a rule put in a class other than S go through the same
pipeline to fill those fields, and the rule's class is treated as a claim to
check, not a fact. The S rules decided about 9,900 shipped entries that no agent
would otherwise look at: a sample of each rule's victims (every twentieth, at
least 10 and at most 60 per rule, 608 in all) goes to the verifier with the
default of suspecting S. A rule that a sample shows wrong is narrowed and its
victims are decided again. 35 batches.

### 4c. What the member inventory cannot see

BCD and webref list members, but a lot of what a proxy on one origin must get
right is not a member:

- **State the browser keys by the real origin or site.** Chromium's own lists
  name it: content settings, permissions, site data types, the partitioned
  HTTP cache, socket pool and HSTS state, `:visited`, saved passwords and
  autofill, device grants, registrations for push, sync and protocol handlers.
  All proxied sites share each of these unless STomp partitions it. The phase 4
  pilot found per-origin permission grants (window management, local fonts)
  shared by every site this way.
- **Browser UI that shows or acts on the origin:** dialogs, print headers,
  prompts, notifications, downloads, context menu actions, install.
- **HTTP processing that is not an IDL member:** every response header with a
  browser effect, the request headers the browser adds, status codes, redirects,
  sniffing, charset detection, Subresource Integrity (rewriting changes bytes),
  caching, origin trials (a token is valid for the site's origin only).
- **Realm and browsing-context kinds,** each measured by phase 2's walk.
- **Network identity:** TLS, HTTP/2 and HTTP/3 fingerprints, header order, the
  WebSocket handshake.
- **Cross-site leak techniques** (xsleaks.dev), since two proxied sites share
  one origin and one partition.

These go in a second inventory, `behaviors.jsonl`, built from those lists, and
through the same classify and verify pipeline as phase 4.

### 4d. Differentials

Some classes are best covered by an oracle, not by reading:

- **JavaScript (class J):** every test262 test that passes natively must pass
  after STomp rewrites it.
- **HTML, CSS and URL parsing:** grammar-based fuzzers compare what Chrome 157
  requests and runs, native against proxied. The pilot found by reading that an
  upper-case `URL(` in a style write goes out unrouted. A generator finds every
  case of that class.

Both become CI gates in the adversarial-\* style.

### 5. Gap list and tests

Join: every non-S entry with `stomp` = missing, or with no test, is a gap.
Rank: escape (a page reaches another site or runs unrewritten code) first,
then leak (the proxy's URL or origin shows, a request goes out unrouted),
then fidelity, then cosmetic. Generate probes where the class makes one
mechanical (a U-in member: set a URL, observe the request and the read-back;
a U-out member: compare with native; an X sink: the adversarial payload
corpus), and write the rest by hand. Probes land as suites in the existing
native-vs-proxied style; escapes go into the adversarial-* gate.
Artifact: `gaps.md` (ranked) and new suites, each failing before its fix.

### 6. Fix streams

Gaps are worked in ranked order as ordinary streams (one agent per family,
fail-before tests, the usual landing gate). The audit's tables are updated by
each landing.

### 7. Keep it true

A CI check compares Chrome's runtime enumeration with `classified.jsonl` and
fails on any member no entry covers, so a new Chrome's surface (Chrome 157's
44 markup members were found by accident) is classified before it ships to
users. BCD and webref are bumped monthly and the diff is classified the same
way.

## What is out of scope, and why

Nothing is out of scope by area. An entry is out only by its own S reason.
WebDriver and WebExtensions entries in BCD are out (a page cannot reach them),
and so is anything Chrome does not ship unflagged, until it does.
