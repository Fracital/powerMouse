# declarativeNetRequest

STomp applies Chrome extensions' `chrome.declarativeNetRequest` rules
(DNR) in its service worker, on the requests it routes. Every rule Chrome
157 accepts is accepted here, every rule it refuses is refused with
Chrome's message, and a request comes out with the action Chrome takes on
it with the same rules. Matching happens in the worker. The page's inject
gets no byte of it, and a page with no extension rules loses nothing.

The code is in `src/extensions/dnr` (the compiler, the index, the matcher
and the API) and `src/server/dnr.ts` (the worker's side: frames, tabs,
host permissions, the request path and the `dnr` RPC).

## The interface

### In the worker

`DnrHost` (src/server/dnr.ts) is created with the server
(`server.dnr`). The extensions layer gives it the rules and the facts the
worker cannot see:

```ts
dnr.install({
	id,                      // the extension id
	installTime,             // larger is more recent; a tie between extensions goes to it
	extensionBase,           // where extensionPath redirects point, https://<id>.invalid/
	rulesets: [{ id, enabled, path, rules }], // rule_resources in manifest order; rules is the file's text or its JSON
	permissions: { declarativeNetRequest, declarativeNetRequestFeedback, activeTab },
	hostPermissions,         // match patterns; absent means every host
	withheldHostPermissions, // hosts the user withheld (runtime host permissions)
	state,                   // what onPersist last gave for it: enabled rulesets, disabled rule ids, dynamic rules
}); // returns Chrome's install warnings, an install error first
dnr.uninstall(id);
dnr.call(id, 'updateDynamicRules', [options]); // any chrome.declarativeNetRequest function, Chrome's errors
dnr.tabOf = (clientId) => tabId;     // -1 without tabs
dnr.parentOf = (clientId) => parent; // the client that frames a nested document, when known
dnr.hostNavigationTab = (url) => tabId; // the tab the host sent to url (a frame's go()), -1 for none
dnr.onPersist = (id, state) => {...}; // store it with the extension
dnr.hooks = { debug, badge, withheld, validTab, activeTabGranted };
```

The rules live in the worker's memory. The extensions layer installs each
extension again when the worker starts (it holds the packages and what
`onPersist` gave), as Chrome loads the indexed rulesets at startup.
Session rules are kept until the worker stops, as Chrome keeps them until
the browser closes.

### From the host page

`controller.dnr(command)` on `StompController` and `RemoteController`
sends the same commands over the `dnr` RPC:

| command                                         | answer                                                |
| ----------------------------------------------- | ----------------------------------------------------- |
| `{ op: 'install', extension }`                  | the install warnings                                  |
| `{ op: 'uninstall', id }`                       | null                                                  |
| `{ op: 'call', id, method, args, userGesture }` | what the chrome.declarativeNetRequest call answers    |
| `{ op: 'stats', reset }`                        | rule counts, the last install's cost, request samples |
| `{ op: 'bench', requests, repeat }`             | the matching cost over a request corpus (below)       |

### As a library

`src/extensions/dnr/index.ts`:

```ts
compile(rulesets, options) => CompiledRules  // one extension's static rulesets, as Chrome installs them
match(request, compiled) => DnrAction[]       // one block, collapse, redirect, upgradeScheme or allow, or the modifyHeaders actions
new DnrEngine(hooks)                          // several extensions, the whole API and the request path
```

A `DnrRequest` is `{ url, initiator, type, method, tabId, topUrl, frame,
frameId?, parentFrameId? }`.
A `DnrAction` is `{ type, extensionId, rulesetId, ruleId, priority,
redirectUrl?, requestHeaders?, responseHeaders? }`.

## Where it runs in the request path

src/server/rewrites.ts, in the order Chrome's network stack asks:

1. **onBeforeRequest.** This runs after the routing and before the host's
   request rules, the HTTP cache and the transport.
   - A block is the content blocker's network error, and a blocked
     top-level navigation gets the host's error page.
   - A redirect or upgrade answers a 307 to the routed target. The browser
     follows it, so the redirected request meets the rules again, as
     Chrome's internal redirect does.
   - A request the worker makes itself (an emulated service worker's
     script) is not matched. DNR never sees a browser-internal request.
2. **onBeforeSendHeaders.** The request header changes apply to the
   headers as they go out, including the jar's Cookie.
3. **onHeadersReceived.**
   - Rules with response header conditions run on the response's header
     lines, Set-Cookie included. A block or redirect at this point ends
     the request.
   - Then the response header changes apply, before the jar takes the
     Set-Cookie lines and before the rewriter reads the rest.
   - An answer of the page's emulated service worker is not the network's
     and is left alone.
4. **The commit.**
   - A navigation's document commits in its frame (the client its
     navigation made). Its allowAllRequests then covers the requests that
     client makes.
   - A frame keeps the higher of its own navigation's allowAllRequests and
     its parent's.
5. **Sockets.**
   - A WebSocket or a WebTransport session never passes the worker. While
     any extension has rules, the controller asks the worker from its
     handshake hook (the `socket` RPC, as for the built-in blocker), and a
     block refuses the socket.

The extensions' rules do not depend on the site's shields, which are the
built-in blocker's. Both blockers apply: a request either one blocks is
blocked.

## Design

A rule is compiled once, at install or update. The compiler is a port of
Chromium's `IndexedRule::CreateIndexedRule`. It runs Chrome's checks in
Chrome's order, then lowercases and sorts the domain lists, parses the
urlFilter into Chromium's `UrlPattern` (anchors, `*`, `^`), translates the
regexFilter from RE2 to an equivalent JavaScript RegExp (src/extensions/dnr/re2.ts),
validates the redirect, the transform and the headers, and turns the
resource types and methods into bit masks.

The index is modeled on Chromium's `url_pattern_index`. Each extension's
rules are filed per stage (before the request, or with response headers),
each rule under one key:

- its rarest five-character n-gram, the one the fewest rules' patterns
  hold. This beats Chromium's smallest-bucket choice on real lists. When
  only common n-grams are on offer (`ps://`, `.com/`), the rule is filed
  under its domain lists instead.
- else each of its requestDomains, then each of its initiatorDomains, as
  hashed label suffixes;
- else a short list that every request scans.

A regex rule is filed under an n-gram of a literal that every match must
contain (the RE2 module computes them), so most regexes never run.

The buckets are open-addressing tables over `Int32Array`s, behind a bitmap
small enough to stay in cache. Most of a URL's n-gram probes stop at the
bitmap.

A request computes its URL's n-grams and its hosts' suffix hashes once,
visits each bucket they name, and visits each rule at most once (an epoch
on the rule). Each candidate is checked cheapest first: resource type,
method, party, tab and top domain, the pattern, the domain lists, and the
regex last.

**Updates are incremental.** The rulesets one change adds are indexed as a
group of their own: an `updateDynamicRules`, a ruleset enabled or an
`updateSessionRules`. The rest is never re-indexed. Rules that were
removed or replaced are skipped until their group is mostly gone, and an
extension with more than six groups has them merged.

**Why not the blocker's engine (adblock-rust).** It has no rule priorities,
no modifyHeaders, no excludedRequestDomains, no tab ids, no per-ruleset
result and no allowAllRequests per frame, so DNR's semantics cannot be
expressed in it. STicks' translation onto STomp's request rules has a
different problem. It keeps 23% of uBO Lite's default rules and matches by
a linear scan: about 1.6 µs per rule per request, 8 ms per request at its
5,000-rule cap.

## Semantics

**Exact** (ported from Chromium 157, checked against Chrome 157 by the rows
of test/dnr/cases.mjs):

- **Conditions:** every one.
  - urlFilter, with `|`, `||`, `*`, `^` and case sensitivity, matched on
    the URL Chrome matches: canonical, fragment kept, the host's span
    known for `||`.
  - regexFilter under RE2's syntax, with Latin-1 and the 2 KiB program
    limit (REGEX_TOO_LARGE).
  - initiatorDomains and requestDomains, with their excluded lists.
    Matching is by Chromium's longest-subdomain rule, and an excluded list
    wins only with a strictly longer entry.
  - topDomains and excludedTopDomains.
  - resourceTypes and excludedResourceTypes, with Chrome's defaults
    (everything but main_frame).
  - requestMethods and excludedRequestMethods.
  - domainType, judged by registrable domain.
  - tabIds and excludedTabIds (session rules only).
  - responseHeaders and excludedResponseHeaders, with values and excluded
    values as `base::MatchPattern` globs. A header's line is split at its
    commas, as HttpResponseHeaders splits it, except for the headers that
    never coalesce (Set-Cookie, Location, Date and the others).
- **Actions:** every one.
  - block, which is collapse for an image or a frame.
  - allow and allowAllRequests, the latter per frame and inherited by
    child frames.
  - upgradeScheme, for http and ftp only.
  - redirect by url, extensionPath, transform or regexSubstitution.
    - A transform rebuilds the URL's components as GURL does.
    - The query edit is QueryIterator's: every kept parameter written as
      `key=value`, values escaped as Chrome escapes them.
    - Chrome's no-ops are kept and still mask the rules under them: a
      redirect to the same URL, a redirect of a WebSocket, a javascript:
      substitution, an upgrade of an https URL.
  - modifyHeaders on request and response headers.
    - set, append and remove follow Chrome's conflict rules: a remove
      blocks every later operation on the header, an append allows only
      appends, and a set allows only the same extension's appends.
    - A request append uses the allow-listed headers' delimiters.
    - The changes apply in priority order across rulesets and extensions.
    - Only an action that changed something is reported as matched.
- **Resolution.**
  - **Within a ruleset:** the top rule of each of its main, allowAllRequests
    and regex indexes, by (priority, rank of the action type, ruleset,
    rule id).
  - **Within an extension:** its rulesets in matcher order (session,
    dynamic, static by manifest order), each against the highest allow so
    far. An allow carries from the request to the response stage.
  - **Between extensions:** block over redirect over allow, and the most
    recently installed extension wins a tie.
  - **headersReceived:** a new block or redirect ends the request, a new
    allow erases what it outranks, and new header changes merge by install
    time, extension and priority.
  - **Host access:** a redirect needs host access, and with
    declarativeNetRequestWithHostAccess alone every action does. A
    withheld host drops the action and notifies.
  - **Who sees a request:** an extension's rules apply to its own requests
    and to any main frame, not to another extension's other requests.
    chrome-extension, chrome, chrome-untrusted, chrome-search and devtools
    URLs are seen by none. A redirect to a file URL is dropped, as for an
    extension without file access.
- **Install and updates.**
  - **Install:**
    - A schema error is a warning: "Rule with id N couldn't be parsed",
      with at most five warnings and a summary after.
    - Any other invalid rule, or a duplicate id, fails the install with
      `<file>: <message>`.
    - REGEX_TOO_LARGE skips the rule with a warning.
  - **Limits:**
    - 1,000 regex rules.
    - 330,000 rules per ruleset, beyond which the ruleset is ignored.
    - The 30,000 guaranteed rules and the 300,000-rule global pool,
      allocated per extension. A ruleset that does not fit is not enabled,
      with Chrome's warning.
    - 50 enabled rulesets.
    - 30,000 dynamic and session rules, 5,000 of them unsafe.
    - 5,000 rules disabled by updateStaticRules.
  - **Updates:**
    - Removals first.
    - A dynamic rule that is now too large is dropped quietly if it was
      already there. A new one fails the update.
    - Re-enabling an enabled ruleset reloads it, losing its frame state, as
      in Chrome.
  - **Quirks kept:**
    - disabled static rule ids apply to url rules only.
    - URLs longer than 2 MiB skip the url index but not the regex rules.
    - Empty header value lists count as absent.
- **Feedback.**
  - getMatchedRules:
    - needs declarativeNetRequestFeedback, or activeTab granted for the
      tab;
    - allows 20 calls per 10 minutes, except from a user gesture;
    - holds a main frame's match until it commits;
    - keeps rules matched outside any tab for five minutes.
  - onRuleMatchedDebug and the action count badge
    (setExtensionActionOptions) work as in Chrome.
  - isRegexSupported and testMatchOutcome run Chrome's own logic,
    including the header name validation quirk in testMatchOutcome.

**Not exact, and why:**

- **Frames.** A service worker sees which client makes a request, but not
  which document frames a nested one. The document that starts a nested
  navigation tells the worker (its navigation hint): a document that set
  a frame's src is the frame's parent, and a frame that navigated itself
  keeps its parent. Without that word (a navigation no hooked document
  started), the parent is the most recently committed document of the
  origin the navigation came from, which is exact for one frame of a site
  per tab. `parentOf`, when set, answers first.
- **Tabs.** tabIds, getMatchedRules by tab and the badge need the
  extensions layer's tabs (`tabOf`). A frame is in its parent's tab, a
  main frame's own request in the tab the host sent it to
  (`hostNavigationTab`, from a frame's `go()`) or in the tab of the
  document that started it. Without the extensions layer every request is
  tab -1, as Chrome treats a request no tab owns.
- **Frame ids.** A tab's top document is frame 0 for its own requests and
  as the parent of its frames. A nested document's own frame id is the
  extensions layer's, which the worker does not keep, so its requests and
  its frames' report -1.
- **Collapse is a block.** Collapsing the element would mean inject code
  in every page. The request is blocked as Chrome blocks it, and the empty
  element stays.
- **Socket headers.** modifyHeaders on a WebSocket handshake is not
  applied: the controller builds the handshake, and only the block
  decision reaches it.
- **Headers added later.** The transport sets some headers after DNR's
  step (Host, Connection, Content-Length, a User-Agent when none is
  there), so a rule's change to one of those does not reach the wire.
- **Cache hits.** Response header rules also run on HTTP cache hits,
  because STomp's cache sits below DNR's step. That is
  unverified against Chrome, which runs onHeadersReceived only for the
  network's responses.
- **URL parsing.** The worker parses URLs with WHATWG URL, not GURL. They
  differ on a few odd hosts and schemes that a proxied request does not
  carry.
- **getDynamicRules.** It answers the rules as they were given, unknown
  keys included, where Chrome drops unknown keys.
- **Header value matching with host access.** Chromium's main branch
  restricts it to extensions with host access. Chrome 157 does not, as a
  live check of the rows shows, and neither does the engine by default
  (its `restrictHeaderValueMatching` turns the restriction on).

## Measurements

Measured on 2026-11-19, on a machine with a load average of 60 to 90 on 32
cores, so absolute times are inflated, perhaps 1.5 to 3 times. Matching
was run on 57,603 requests (every fourth) of adblock-rust's request corpus.
Times are µs per request; "warm" means each request matched 32 times in a
row.

| rules                               | rules   | compile  | index    | heap (compiled + index) | node p50 / p99 | worker (Chrome 157) mean, p50 / p99 warm         |
| ----------------------------------- | ------- | -------- | -------- | ----------------------- | -------------- | ------------------------------------------------ |
| uBO Lite, the 6 default rulesets    | 18,988  | 223 ms   | 236 ms   | 8.6 + 14.9 MB           | 10.3 / 69      | 39 cold pass, 11.7 / 89                          |
| uBO Lite, all 56                    | 70,506  | 435 ms   | 941 ms   | 20.9 + 41.3 MB          | 22 / 213       | 47, 18.8 / 158                                   |
| AdGuard MV3, all 52 (one extension) | 370,950 | 1,992 ms | 5,046 ms | 78.7 + 166.8 MB         | 21 / 195       | 36, 16.9 / 88 (251,504 enabled: Chrome's limits) |

- **The worker's own install.** Compile then index in the worker took
  160 + 197 ms for uBO Lite's defaults, 331 + 509 ms for all of uBO Lite,
  and 1,119 + 2,618 ms for AdGuard's enabled share.
- **Incremental updates.** One updateDynamicRules call with uBO Lite
  installed takes 0.2 to 0.5 ms for an add or a remove, round trip from
  the page, once warm.
- **Comparisons**, all on the same corpus
  (~/.claude/stomp-work/extensions/dnr/bench-baselines/RESULTS.md):
  - **STicks' translation:** 8,038 µs p50 and 19,385 µs p99 at its
    5,000-rule cap. Without the cap it takes 26,839 µs p50 for uBO Lite's
    defaults, and AdGuard runs out of memory.
  - **The built-in blocker (adblock-rust):** `decide()` takes 17.3 µs p50
    and 231 µs p99 with the eight default lists.
- **uBO Lite on theguardian.com/international**, with the built-in blocker
  off (`?noadblock`), compared with native Chrome running uBO Lite
  (extensions audit):

  |                  | requests | blocked | ad requests | ads completed | ads blocked |
  | ---------------- | -------- | ------- | ----------- | ------------- | ----------- |
  | native, two runs | 139      | 27      | 6           | 3             | 3           |
  | STomp, two runs  | 144, 148 | 29, 31  | 7           | 3             | 4           |
  | STomp, no rules  | 567, 633 | 0       | 213         | 213           | 0           |
  | STicks (audit)   |          | 8       | 29          | 25            |             |

  The blocked hosts are native's, host for host. The differences are a
  second request to sb.scorecardresearch.com, one or two more
  ophan.theguardian.com beacons, and one sentry.io report in one run.

## Tests

- `test/suites/dnr-unit.mjs`: one row per case Chrome documents or
  Chromium tests (test/dnr/cases.mjs, each checked against Chrome 157).
  It covers urlFilter matching, rule validation and its messages, RE2
  support and the matching outcomes.
- `test/suites/dnr-re2-unit.mjs`: the RE2 translation against native RE2
  at Chromium's pinned revision.
- `test/suites/dnr.mjs`: through the proxy in Chrome. It checks block,
  allow, each redirect kind, upgrade, request and response header changes
  (a removed Set-Cookie included), response header conditions, block
  between extensions, allowAllRequests, a blocked navigation, a blocked
  WebSocket, dynamic rules, the feedback calls and uninstall.
