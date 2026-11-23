# The built-in content blocker

STomp can block what a content blocker in the user's browser would block:
ad and tracker requests never leave, the elements the lists name are hidden,
and the lists' scriptlets run in the page. It is on by default; a host
turns it off with `adblock: false`, and then nothing of it is fetched or
run.

```js
const controller = new StompController({
	// ...
	// adblock: false,
});
```

The engine is Brave's `adblock` crate (adblock-rust 0.13.5, MPL-2.0)
compiled to wasm (`rust/block`, shipped as `dist/blocker.wasm`, 1,063 KB and
299 KB with brotli). It reads the filter syntax of EasyList and uBlock
Origin. The plan and the reasons behind the design are in
`docs/rust-plan.md`, section 8.

## The option

`adblock` on `StompController` and `RemoteController`: left out (on, see
"By default"), `false`, `true`, or an object.

| Field       | Meaning                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lists`     | the filter lists: URLs, or `{ url, trusted, format }`. Default: EasyList, EasyPrivacy and uBlock Origin's filters, unbreak, badware, privacy, resource abuse and quick fixes lists |
| `resources` | the URL of the redirect resources and scriptlets, in the format of Brave's `resources.json`. Default: uBlock Origin's, `adblock-resources.json` in the directory (see below)       |
| `engine`    | the URL of a serialized engine to load in place of fetching and compiling `lists` (see below)                                                                                      |
| `refresh`   | hours between refreshes of the lists, default 24                                                                                                                                   |

`trusted: true` on a list lets it use the `trusted-*` scriptlets, which edit
a page's cookies, storage and responses. uBlock Origin's own lists are
trusted by default, as in uBlock Origin; a list given as a plain URL is not.
`format: 'hosts'` reads a hosts file.

The lists are not bundled. They are fetched at runtime by the service
worker through the controller's transport, like a page's own requests, so
the list servers see the wisp server's address and never the user's. The
default resources are a file of the package: uBlock Origin's scriptlets and
redirect resources (`dist/adblock-resources.json`, GPL-3.0 like STomp, 473
KB and 104 KB with gzip), which the worker reads from its own origin, the
directory, like `blocker.wasm`. They are built from a uBlock Origin release
(see "Building the resources"), because the lists name uBO's scriptlets and
are written for the uBO release that ships them; Brave's published
`resources.json` holds only Brave's own resources (25 of them, 2026-11-17)
and none of uBO's, so with it no `+js()` rule of the default lists ran and a
`$redirect` rule blocked instead. A host that names its own `resources` is
fetched through the transport as before. The compiled engine is kept in
CacheStorage (`stomp-adblock`) with the resources, keyed by the list URLs
and the engine's format, so a restarted worker loads it in milliseconds and
the lists are fetched again only once the stored engine is older than
`refresh`. A list that cannot be
fetched is left out. With no list fetched at all the blocker stays off and
pages load unfiltered; without the resources it blocks and hides, with no
scriptlet and no `$redirect` answer, says so once on the console and stores
nothing, so the next worker tries them again. The stored engine, when there
is one, keeps serving while a refresh fails.

The module itself (`blocker.wasm`, named by `init.assets.blocker`, served
from `init.directory` with the other files) is one more of the controller's
wasm modules (`src/wasm/thread.ts`): the controller fetches it once and
hands its bytes to the service worker with the handshake
(`ControllerInitMessage.modules.blocker`), which compiles them on its own
thread. A compiled `WebAssembly.Module` cannot be posted to a service
worker, so the controller never compiles it. Compiling the lists into an
engine is one call into the module (220 to 280 ms for the default lists),
which on the service worker's thread held every request of the pages it
served meanwhile: when the controller runs rewrite workers, the service
worker sends one of them the module's bytes and the lists' text, and it
compiles the engine and sends its bytes back (`src/blocker/build.ts`); the
service worker loads it as it loads a stored one. With no rewrite worker,
or none that answers, the service worker compiles it itself, as before.
When the module cannot be fetched the controller says so on the console and
runs without the blocker.

With `true` or an object, the first navigation waits for the engine, for
five seconds at the most; past that the document loads unfiltered and the
engine serves from the moment it is built. With the option left out it
waits for the engine snapshot instead (below), a second at the most. A
document that loaded unfiltered stays so for as long as it is open, because
a scriptlet runs before the page's first script or never: on a YouTube
watch page every related video the user clicks is the same document, whose
player fetches the next video's data with a `fetch` it took from a frame of
its own while the page loaded, so a first visit that did not wait played
the pre-roll ads of every video after the first one.

### By default

A controller that is not given the option runs the blocker with the default
lists, as `adblock: true` does, except that what it cannot have never gets
in the way of a host that did not ask for it:

- A host that does not serve `blocker.wasm` gets one `console.info` line from
  the controller (`Stomp: the content blocker is off, its module did not
load`); no list is asked for and the inject installs nothing for the
  blocker. When every list cannot be fetched (a wisp server that does not
  reach the list servers), the service worker says it once
  (`Stomp: the content blocker is off: ...`) and pages load unfiltered; a
  single default list that fails is left out without a line. The next
  controller to shake hands tries again. With `true` or an object the module
  and each list that fails are a `console.warn`, as before.
- No navigation waits for the list servers. With an engine stored it serves
  (milliseconds to load); with none (a first visit, or cleared site data)
  the engine snapshot does (below), and a navigation waits for it a second
  at the most. A directory that does not serve the snapshot, or one that
  takes longer, leaves the documents before the lists' engine unfiltered.
- The lists are downloaded after the worker's first navigation has been
  answered (and 250 ms more, for the page's first subresources), or 2 s
  after the start when no page is asked for. When an engine with every rule
  of the lists already serves (the snapshot, or a stored engine past its
  `refresh`), the download waits for the pages' requests to the transport
  to have been quiet for 10 s too, a minute after the first navigation at
  the most: the downloads (6 MB over the page's own wisp connection) and
  the build (250 to 450 ms on a rewrite worker) had landed in the middle of
  a first visit's load, and cost a fresh profile 0.7 s of Chrome's CPU in
  it. The wisp server looks up the name of every
  connection on a few threads (four on holyWisp), and the lists' hosts
  asked for at the same moment as the user's first page held them: the
  page's own lookup waited, up to 1.5 s in the bench with a cold DNS
  cache. The lists of one host are asked for once its first list has
  answered, over the same connection, so each host is looked up once.
  With `true` or an object the first navigation waits for the engine
  instead, and the lists are downloaded at once.

The first handshake waits for `blocker.wasm` either way (fetched beside the
transport's module), so serve it with the cache headers of the other files,
and serve `adblock-resources.json` and `adblock-snapshot.dat.gz` beside it.
A host that renames the files names them in `init.assets.blocker`,
`init.assets.adblockResources` and `init.assets.adblockSnapshot`.

### The snapshot

`adblock-snapshot.dat.gz` is an engine of the eight default lists
(`SNAPSHOT_LISTS`, `src/blocker/types.ts`), compiled and serialized by
`blocker.wasm` as the service worker stores its own, and gzipped. A worker
on by default with no engine stored fetches it from its own origin (never
through the transport) with the resources, decompresses it
(`DecompressionStream('gzip')`, in Chrome, Firefox and Safari alike), loads
it, and serves it until the default lists, fetched again once the pages
have gone quiet (above), are built; their engine replaces it, and is the
one stored. The snapshot itself is never
stored: a worker that starts again before the lists' engine was built loads
it again, from the browser's HTTP cache.

It is stored compressed so that it is 3.6 MB on the wire (8.5 MB
decompressed) however the host serves `dist/`: serve it as the file it is,
`application/octet-stream` with no `Content-Encoding` (the demo server
does). A host that answers it with `Content-Encoding: gzip` anyway still
works, since the browser then hands the worker the decompressed bytes and
the worker takes bytes without gzip's magic number as they are. The
controller asks for it as `adblock-snapshot.dat.gz?<hash of its bytes>`, so
a host may answer that URL `Cache-Control: public, max-age=31536000,
immutable` (the demo server does).

In headless Chrome 157's service worker (2026-11-19) the decompression
takes 9.3 to 13.9 ms and the load 4.7 to 9.2 ms (an outlier of 12.9 ms),
against about 240 ms to compile the lists. A first visit to example.org
through the local demo, a fresh profile each, two runs of ten of each
alternated on a loaded machine: 333 to 752 ms (median 465) with the blocker
and 297 to 492 ms (median 402) without it, then 261 to 493 ms (median 301)
and 214 to 518 ms (median 276). Waiting for the lists' first build instead
had taken 881 to 1092 ms.

It held uBlock Origin's six lists alone until 2026-11 (1.1 MB gzipped, 2.5
MB raw), EasyList and EasyPrivacy left out for size. A fresh profile then
downloaded and compiled the eight lists during its first page load, as
soon as the first navigation had been answered: in the bench's article
page that was 0.65 s more of Chrome's CPU per fresh profile (1,760 against
1,110 ms) and 158 MB more memory on a blank tab (492 against 334 MB), and
the EasyLists' network rules (YouTube's `/pagead/` and `/api/stats/ads`
beacons among them) did not block until it was done. With brotli the eight
lists' engine was 2.84 MB, six uBlock Origin lists and EasyPrivacy 1.70
MB, six and EasyList 2.00 MB, uBlock Origin's filters and quick fixes alone
0.67 MB.

`node scripts/adblock-snapshot.mjs` fetches the lists as they are now and
writes `assets/adblock-snapshot.dat.gz` and `assets/adblock-snapshot.UPSTREAM`
(each list's digest, the module's, the file's and the date). The snapshot
only bridges the seconds until the worker's own build, so it is made again
now and then, not on every build. It must be made again when
`blocker.wasm` changes, since its serialization is the crate's: the build
refuses a snapshot whose `UPSTREAM` names another module or another file.
`node scripts/adblock-snapshot.mjs --check` fails once the lists are more
than 14 days old, and the nightly workflow runs it: its `snapshot` job is
red every night until the snapshot is made again and committed (the
publish goes ahead, since an old snapshot still serves until the lists'
engine does). The age is not checked by the build, so an old checkout
builds as it did.

### A prebuilt engine

A host that does not want every browser to compile the lists can build the
engine once and serve the bytes:

```js
adblock: {
	engine: '/assets/engine.dat';
}
```

The bytes are the crate's own serialization (`Engine::serialize`, the
flatbuffers format, version 8). The crate checks the format's version and
nothing else, so only load an engine that the same `blocker.wasm` built
(`OP.addList` for each list, `OP.build`, then the output: see
`test/suites/adblock-engine.mjs` for the dozen lines it takes in node). The
resources are not part of the engine and are still fetched.

### Changing the lists

A host application can change the lists while the proxy runs, without a
reload. `controller.setAdblockLists(lists)` replaces the lists the blocker
serves; the service worker rebuilds the engine and swaps it in once it is
compiled, keeping the old lists serving in between, so the change is live.
The new lists travel with every later handshake too, so a worker that
restarts rebuilds from them. It returns `{ applied: 'live' }` when the
blocker is on to apply them, `{ applied: 'off' }` when the host turned it
off. `controller.refreshAdblockLists()` re-fetches and recompiles the
current lists even when the stored engine for them is still fresh (a
"check for updates" button).

The live change is forward-looking, as a content blocker's own is: new
requests and newly built documents are judged by the new lists, and a
document already on screen keeps the cosmetic rules it was built with until
it is navigated again.

`controller.adblockDefaults()` returns the default lists (with their `name`),
for a settings UI to show as toggle rows, and `controller.getAdblockLists()`
the lists in force. `ControllerInit.adblockLists` seeds a non-default set on
the first handshake, so a host that persisted the user's choices builds the
engine from them once rather than rebuilding after a default build.

A list may carry its filter text itself, in `filters`, in place of a `url`
to fetch: the blocker compiles that text directly. This is how the demo's
"custom filters" editor feeds the user's own uBlock-syntax rules to the
engine, as one inline list alongside the fetched ones. An inline list's
`url` only names it for the engine's cache key, and it must stay untrusted
(`trusted: false`): the `trusted-*` scriptlets, which edit a page's cookies,
storage and responses, are never run from rules a user typed.

## What it does

**Requests.** The service worker asks the engine before a request reaches
the host's rules, the page's emulated service worker, the HTTP cache or the
transport. The request is judged by its real URL, by the real URL of the
document or worker that makes it (for a nested document, the page that
frames it; a top-level document is its own first party) and by its type as
a content blocker would name it: `script`, `stylesheet`, `image`, `font`,
`media`, `object`, `subdocument`, `document`, `xmlhttprequest` for a fetch
or XHR, `ping` for a beacon. In proxy URL space every request is
same-origin with its page; none of that is used.

- A blocked request is a network error, as `net::ERR_BLOCKED_BY_CLIENT` is
  to a page: `fetch` rejects with `TypeError: Failed to fetch`, an image
  fires `error`, a frame shows the browser's error page. There is no status,
  header or body of the proxy's. A blocked top-level document gets the
  host's error page (`init.errorPage`, kind `blocked`) when there is one.
- `$redirect` answers with the resource (an empty script, a 1x1 image) and
  the resource is rewritten like the origin's own answer would have been.
- `$removeparam` sends the request without the parameters; a navigation is
  redirected, so the document's URL is the one fetched.
- `$csp` policies are added to the document's response when the proxy can
  enforce them. The browser applies a policy to proxy URLs, where every
  origin is the proxy's, and the proxy's own shell runs inside the document,
  so only directives whose sources are keywords, schemes or `*` are carried,
  never `sandbox`, and a script policy only when it still allows inline
  scripts and `eval` (`src/blocker/csp.ts`). `worker-src 'none'` holds;
  `script-src 'self'` is dropped. Every carried policy lets one worker
  run whatever it says of workers: the proxy's own for sealed copies, from
  the service worker's route `<directory>sealer`, named by its full URL
  among the policy's worker sources (docs/same-origin-policy.md, the load
  gate).
- The host's request log (`onRequest`) reports a blocked request with status
  0, kind `blocked` and the error `blocked by the content blocker`.

**WebSockets.** A socket never passes the service worker: the page's inject
(a document's or a worker's) opens it on the transport, whose host (the
controller, or its transport worker) lets the controller add the cookie
jar's header to the handshake first. That hook is where a socket is judged.
The controller asks the service worker (one more message each way on the
port they already share, sent beside the question for the cookies, so a
socket waits for nothing new), the worker asks the same engine with the
type `websocket`, the socket's real `ws:` or `wss:` URL and the origin its
handshake carries, which is the real origin of the document or worker that
opened it and all the engine reads of a source (its host, for `$domain` and
`$third-party`). On a yes the hook refuses the handshake
(`HANDSHAKE_REFUSED`, `src/transport/serveTransport.ts`) and the transport
never hears of the socket: no stream is opened on the wisp connection.

- The page sees what it sees natively of a socket a content blocker refused,
  which is what it sees of any socket that could not connect (Chrome for
  Testing 156 with a `declarativeNetRequest` rule): `readyState` goes from
  `CONNECTING` to `CLOSED`, `error` fires, and `close` follows in the same
  task with code 1006, no reason and `wasClean` false. The `adblock` suite
  compares the two sequences in the browser it runs in.
- Sockets opened from a dedicated worker, a shared worker and an emulated
  service worker take the same path and get the same answer.
- Only an explicit refusal fails a socket. With no answer (the service
  worker is restarting, the question took more than the hook's two seconds)
  the socket connects, as every request passes while no engine answers; a
  socket is not a navigation, so it does not wait for an engine that is
  still being built.
- `onRequest` reports a blocked socket like a blocked request (status 0,
  kind `blocked`, destination `websocket`), without a frame: the handshake
  hook does not know which page a socket belongs to. Sockets that connect
  are not reported, as before.
- A `$redirect` rule that matches a socket blocks it, as in uBlock Origin;
  `$removeparam` is not applied to sockets.

**Cosmetic rules.** While it builds a document's shell the worker asks the
engine for the document's URL and hands the answer to the inject before
the page's markup:

- hide selectors become rules of a constructed style sheet the document
  adopts. Nothing is added to the DOM or to `document.styleSheets`, and the
  page's `document.adoptedStyleSheets` reads and writes as the list of the
  page's own sheets.
- the generic rules for classes and ids are not sent with every document
  (the lists hold tens of thousands). The inject collects the classes and
  ids the document really uses from mutation records, asks the worker for
  them in batches, and adds what comes back. The mutation callback only
  queues: the work happens in timer slices, off the typing path.
- procedural filters (`:has-text()`, `:matches-css()`, `:matches-attr()`,
  `:matches-path()`, `:min-text-length()`, `:upward()`, `:xpath()`) and
  action filters (`:remove()`, `:style()`, `:remove-attr()`,
  `:remove-class()`) are interpreted in the page
  (`src/blocker/procedural.ts`), with uBlock Origin's semantics, after every
  batch of mutations. An element a procedural filter hides gets an inline
  `display: none !important`, the only way to name one element; a plain
  selector with `:style()` is a rule of the sheet.
- `$generichide` and `#@#` exceptions are honoured.

**Scriptlets.** The page's `+js(...)` scriptlets are one script, which the
worker rewrites like any script of the page. It runs once the document is
opened for the page's markup and before the page's first script, inside a
function (its helpers never become globals), so what a scriptlet wraps is
STomp's hook and what it sees is the page's own URL: a scriptlet that wraps
`fetch` gets the URL the page passed, and `location.href` is the real page.
The function declares `scriptletGlobals`, as uBlock Origin's scriptlet
template and Brave do: uBO's `safeSelf()` reads it, and without it the first
scriptlet of the script threw (the crate orders them by a hash, so a
different rule was lost on each page). A scriptlet that watches the page's
nodes (`replace-node-text`, `remove-node-text`) sees each inline script of
the markup before it runs and as the page wrote it, as it does natively (see
"YouTube").

**YouTube.** YouTube's ads come in the same JSON as the video: the
`adPlacements`, `playerAds` and `adSlots` of the page's
`ytInitialPlayerResponse` and of what `/youtubei/v1/player` answers, so no
network rule can tell them apart. The default lists remove them as uBlock
Origin does, with nothing written for YouTube in STomp: `set-constant` on
`ytInitialPlayerResponse.adPlacements` and its siblings, `json-prune` on
`JSON.parse`, `json-prune-fetch-response`, `json-prune-xhr-response`,
`trusted-replace-fetch-response` and `trusted-replace-xhr-response` on the
player's requests, `replace-node-text` on an inline script, and cosmetic
rules for the feed, companion and masthead slots; the network rules block
the ad pings (`/pagead/`, `/api/stats/ads`, doubleclick) and redirect
`ad_status.js` to uBO's stub. `adblock-youtube` checks the same rules on a
fixture of the player JSON's shape against the page loaded natively with
the engine's scriptlets run at document start.

With `adblock: false` none of this exists: the config carries no `adblock`,
the module is never fetched, the worker has no engine and the inject takes
no natives and installs no hook.

## Per-site shields

A host application can turn STomp's privacy layers on or off per site, the
way Brave Shields does, and the demo (`demo/public/pm`) builds that UI. The
state is host-keyed and the host owns it (the demo keeps it in its own
localStorage); the controller carries it to the service worker, which keeps
one `ShieldsStore` per server (`src/server/shields.ts`) and consults it
before each layer runs. A host with no entry is neutral: STomp behaves as it
would with no shields, so a controller that never sets any (every test
suite's) is unchanged.

`controller.shields` (`src/controller/shields.ts`), on `StompController` and
`RemoteController` alike:

| Call               | What it does                                                          |
| ------------------ | --------------------------------------------------------------------- |
| `get(host)`        | the host's shields, the defaults when it has no entry                 |
| `has(host)`        | whether the host has a stored entry                                   |
| `set(host, patch)` | merge a patch, push the whole set to the worker, return the new state |
| `all()`            | every entry, for the host to persist                                  |
| `replace(list)`    | set them all (on startup, from what the host persisted)               |

`ControllerInit.shields` seeds them, and `onShieldsChange(host, state)` fires
after each `set` so the host can persist it. The set travels with every
handshake, as the request rules do. A `SiteShields` entry
(`src/blocker/types.ts`) is `{ host, enabled, mode, httpsUpgrade,
blockScripts, blockFingerprinting, cookies, forget }`.

`enabled` is the master toggle: down, every layer below is off for the host
without touching STomp's rewriting. In the demo, the Block ads switch in
**Settings > Proxy** (also under the browser hamburger's **Proxy** submenu)
takes the shields down on every site while it is off:
each entry, and a `*` entry for the hosts with none, goes to the controller
with `enabled: false`, the button and panel read down, and the panel's
master switch is disabled. What each site has stored is persisted as it
was, so the sites come back as they were left when Block ads is on again.

Every frame of a tab is governed by the shields of the tab's top-level
page, however deep the frame and whatever its site, as Brave keys a frame's
shields by its main frame: a third-party frame has none of its own, so
framing cannot get around a site's shields. The worker finds that top for
each request (`shieldsHost`, src/server/rewrites.ts): a top-level
navigation is the page itself; a frame's navigation names its top in its
route (the nested mark, src/rewriteHTML.ts); a subresource's client is a
nested document whose route names it, or a dialed document, written into a
call page whose URL names no route, whose call the worker recorded by the
client it made (docs/dialing.md); a partitioned worker, a blob: worker or an
inline document names its top's site only, whose host then stands for the
top. Else the request's document is a top-level one. The document builder
keys Block scripts, the cosmetic filters and the fingerprint surfaces by the
same top, and a WebSocket or WebTransport session is keyed by its client's
top (by the document that opens it when the worker cannot place the
client). The `shields-sites` suite checks a frame of another site two levels
down under shields down and up, in classic and dialed tabs.

What the worker enforces today:

- `mode` (`aggressive` | `standard` | `allow`): the ad/tracker blocker.
  `allow` turns it off for the host. `aggressive` asks every list of every
  request. `standard` (the demo's default, as Brave's) asks the lists
  nothing of a first-party request, one to the registrable domain of its
  top-level page whatever the scheme (a top-level navigation is its own),
  and asks only the host's inline lists (the custom-filters editor's) of
  it: Brave's standard mode asks its default lists nothing of a request to
  the tab's site (they block third-party trackers only) and still asks the
  user's own filters. The inline lists are compiled again on their own for
  this the first time a first-party request is asked about (a few
  milliseconds); a failed compile is the blocker's `ownError`, apart from
  the engine's `lastError`. A WebSocket or WebTransport session to the site
  of its top-level page is judged the same way: the controller names the
  document that opens it, and the worker finds that document's top as it
  does for a request (a socket whose document it cannot place is judged
  by the document's own site). Lists the host names by URL count as default lists
  here, where Brave asks the lists a user subscribed to of first-party
  requests too. A host with no entry for the site (no shields) is judged
  by every list, as before shields existed. This is what kept wisp.baby at
  0 Mbps: its app imports its own `livestats.js`, which EasyPrivacy's
  generic `/livestats.js` rule blocks, so the app never ran (the speedtest
  suite).
- `httpsUpgrade` (`strict` | `upgrade` | `off`): `upgrade` and `strict` upgrade
  the site's http subresources and frame navigations through the
  mixed-content machinery, as a document's upgrade-insecure-requests would.
  `upgrade` leaves the top-level page as it was asked for, so a site with
  no https still loads over http. `strict` (Brave's "require HTTPS") upgrades
  the top-level page too (an IP address excepted, as Chromium's HTTPS-Only
  Mode does), and when the upgraded load fails at the connection or at TLS
  the tab shows a "Connection is not secure" interstitial
  (`src/server/httpsOnly.ts`) instead of the http page: nothing goes to the
  site over http until the user picks "Continue to site", which posts the
  page's one-time token to the worker (no page can make one up) and loads
  the http page. The worker then upgrades nothing of that site for the rest
  of its life (Chromium keeps its HTTPS-Only exceptions for the session).
  In a dialed tab the interstitial asks the host for the page and for "Go
  back" over the call's port, as a dialed document does. A frame's upgraded
  navigation that fails is a failed frame load under both, as under
  upgrade-insecure-requests.
- `cookies` (`all` | `third-party` | `allow`): `all` sends no cookies on the
  host's requests, `third-party` none on cross-site requests, `allow` leaves
  STomp's own jar and SameSite to decide.
- `forget`: the demo clears the site's cookie jar when its last tab closes.
- `blockScripts`: the worker gives the site's documents a policy of
  `script-src 'none'` that the browser never sees (a header like it would
  stop STomp's own shell), and the inject enforces it against the page's
  own code (`src/csp.ts` stage 2, the inject's `ContentSecurity`); STomp's
  scripts are exempt. Off unless an entry turns it on, and off with the
  shields down.
- `blockFingerprinting` is the master switch of the fingerprint
  protection: off, or shields down, protects no surface; on, the entry's
  `fingerprint` map picks the surfaces (a surface it does not name takes
  its default: `performanceMemory` on, the rest off), and the shell hands
  the inject the set as `config.fingerprintOn` (`src/server/shields.ts`).

## Measured

On this machine, node 22, the module as shipped, Brave's main list (6.9 MB,
about 198,000 lines) as the input:

| What                              | wasm                 | native (the crate's own numbers) |
| --------------------------------- | -------------------- | -------------------------------- |
| compile the list                  | 245 to 590 ms        | 82 ms                            |
| load the serialized engine        | 9 to 13 ms           | 1.1 ms                           |
| serialized engine                 | 8.6 MB               |                                  |
| instance memory, serving          | 18.8 MB              | 9.7 MB of heap                   |
| instance memory, while compiling  | 48 MB (then dropped) |                                  |
| one network check                 | 11 to 19 us          | about 5 us                       |
| one document's cosmetic resources | 140 to 175 us        | about 40 us                      |

`ADBLOCK_BENCH_LIST=<file> node test/suites/adblock-engine.mjs` repeats
them. The serving instance is a fresh one that only loaded the serialized
engine; the instance that compiled the lists is dropped with its garbage.

In headless Chrome 152 through the demo (2026-11-10), with the eight default
lists: the lists and the resources were fetched through wisp, compiled and
stored (an engine of 8.5 MB) 1.0 to 1.3 s after the controller was made. A
document then carries 559 generic hide selectors in its shell, and the
requests of a page to an ad server and an analytics script were blocked.

A refused WebSocket reaches its `error` event 0.5 ms after `new WebSocket()`
(median of 25, 1.2 ms at the most; the transport hosted in the page), where
an unlisted socket to a local server opens in 2.6 ms with the blocker on.

## Limits

- The crate does not do HTML filtering (`##^`) or response body `$replace`,
  and drops a whole rule that carries an option it does not know (`popup`,
  `header`, `denyallow`, `replace`).
- WebTransport and WebRTC connections are not judged by the lists.
- A blocker that was built stays in the service worker until the worker
  stops, also when the last controller that asked for it is gone.
- An element whose request was blocked is not collapsed: a blocked image
  keeps its box unless a cosmetic rule hides it.
- Cosmetic rules do not apply inside shadow roots, in `about:blank`,
  `srcdoc` and `blob:` documents, or in XML documents.
- A frame whose parent read its `contentWindow` before its document arrived
  keeps the parent's client (the browser keeps the about:blank Window for a
  document of the same origin). There the lists' selectors hide and the
  scriptlets run, but generic rules by class and id and procedural filters
  do not: they read the document's nodes, and a node the parent's bundle
  reads first is the parent's realm's to the page from then on.
- On wasm the crate never discards a compiled regex (it has no clock), so
  an instance only grows. Past 160 MB of linear memory the worker replaces
  it with a fresh one that loads the stored engine.
- An instance that traps (a Rust panic aborts) is dropped and replaced the
  same way; requests pass unfiltered in between.

## Building the resources

`node scripts/adblock-resources.mjs <dir>`, with `<dir>` a checkout of
uBlock Origin at a release tag (`git clone --depth 1 --branch <tag>
https://github.com/gorhill/uBlock.git <dir>`), writes
`assets/adblock-resources.json` and `assets/adblock-resources.UPSTREAM`
(the tag and commit), as Brave builds the uBO part of the file it ships
(brave-core-crx-packager): every scriptlet uBO registers, as the source of
its function with the names of the functions it calls, and every redirect
resource of uBO's `redirect-resources.js`, with a type from its extension.
The same checkout gives the same bytes. The build copies the file to
`dist/`. Raise the tag when the lists start naming scriptlets or arguments
the file does not have (uBO's own lists follow its releases).

## Building the module

`ENGINE=<docker or a wrapper> deploy/rust/build.sh block blocker` builds
`rust/block` in the pinned toolchain container and writes
`assets/blocker.wasm` with its checksum and provenance
(`deploy/rust/README.md`). The crate's features are `full-regex-handling`,
`single-thread` and `css-validation` (without it a procedural rule would be
handed over as a plain selector). The public suffix list is not compiled
in: the module asks the worker (its one import), which already answers
sites for the cookie jar (`src/suffix.ts`: the core module under
`rewriter: 'wasm'`, tldts otherwise).

The `adblock` crate is used unmodified from crates.io, pinned to 0.13.5
(`rust/Cargo.lock`); its source is https://github.com/brave/adblock-rust
under the Mozilla Public License 2.0.
