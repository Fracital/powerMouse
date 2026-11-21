# The site pool

**Off by default (2026-11-16): the demo uses it with `STOMP_SITE_POOL` set
and the library with `sitePool: { origins }`, and both fall back to the
host's own origin, per page and silently, where a slot does not answer.
Measured against Chrome 152, 156 and 157; docs/process-model.md has the
tables it rests on.**

Every proxied site shares the proxy's one origin, so Chrome puts the frames
of different sites in one renderer process: one event loop, one heap, no
process hop between them (CHANGELOG known limitations). A page can tell,
and a heavy frame of another site holds up the page that embeds it. An
origin of its own for every site splits them as natively, but needs a DNS
name per site, which the deployment does not take on.

`sitePool: { origins: [...] }` on the controller is the split that needs no
name: a small fixed list of origins that differ from the host page's only
by their **port** (`https://proxy.example:2053`, `:2083`, ...), the pool's
slots. Ports of one host are one site to the browser, and a secure document
that sends `Origin-Agent-Cluster: ?1` gets a process keyed by its origin,
port included. Each proxied site is shown from one slot, so a page and a
frame of another site in it are two processes; with more sites than slots
some share one, which is what every site does without a pool.

## On, off and the fallback

- **The library.** `Controller` and `RemoteController` take
  `sitePool: { origins: [...] }`; the demo's server passes the origins it
  serves. `sitePool: false` (or no origins) is the single-origin
  controller, exactly as before the pool.
- **The demo.** `STOMP_SITE_POOL` is the slot ports the demo binds
  besides its own (`5`: five free ports the system chooses; or a list);
  unset, `0` or `off` is no pool. Behind a front that
  serves the slots on ports of its own, `STOMP_SITE_POOL_PUBLIC` names the
  public origins and the front tells the demo which one a request came to
  with `X-Forwarded-Port`. The demo page's `?nopool` leaves the pool out for
  that visit (both pages: same-origin and isolation mode).
- **The fallback.** A slot that does not answer as a STomp slot (Fallbacks,
  below) is left out for the page, and the sites it would show are shown
  from the host's own origin, with nothing a proxied page can see: the
  site-pool-fallback suite has a case for every way a slot can fail.

## What it gives, measured through the proxy

The site-pool suite compares with Chrome on the same fixture (a page of
127.0.0.1 with a frame of localhost). The first two rows are the
turnstile kit's probe, three loads each in Chrome 152 and in 156 (the
ranges cover both):

| observation                                                         | natively       | single origin | pool of five   |
| ------------------------------------------------------------------- | -------------- | ------------- | -------------- |
| the frame's timers while its parent spins 300 ms, worst gap         | 6 to 13 ms     | 301 ms        | 6 to 10 ms     |
| a message to the frame and back, median                             | 0.4 to 1.8 ms  | 0.1 to 0.2 ms | 0.5 to 1.8 ms  |
| the two documents' `performance.memory`                             | differ         | one heap      | differ         |
| the frame, to the browser                                           | out of process | in process    | out of process |
| the frame navigated to its parent's site                            | joins it       | (in process)  | joins it       |
| eight known-open paths to another site's window (window-references) | restricted     | raw           | restricted     |

## Design

**The unit is the site** (registrable domain with the private section, the
membrane's and the jar's key), as Chrome's processes are: a site's own
origins share a slot, so `document.domain`, same-site cookies and windows
of one site work as they do without a pool.

**A site keeps its slot** (`SiteSlots`, src/controller/sitePool.ts). What a
page stores in the browser's own stores (IndexedDB, Cache Storage, the
origin private file system) and what the worker keeps for it (localStorage,
the HTTP and rewrite caches, emulated service worker registrations) is the
slot origin's: a site shown from another slot tomorrow would find nothing
of it (the site-pool suite shows it: a list without a site's slot shows it
with its cookies and not its localStorage). So the first assignment is
kept for good, in the host origin's IndexedDB (database
`kept-site-slots`: `sites`, each site's slot origins, newest first, one
record per site; `slots`, how many sites each slot was given), and every
tab of the host reads the same one. It is kept by slot origin, not by the
list: a changed list (another order, slots added or taken out) keeps every
site whose slot it still has, and a site whose slot it lost is given
another, its earlier slots kept after it for a list that has one again
(site-pool-kept-sites: four changed lists, each in a new tab, and the
first again after a new site; at 37a22599 every one of them moved the
site, the last because only four lists' assignments were kept, and it
read none of what it stored). Nothing is ever dropped, and a full
localStorage (the host's own data, or the 200,000 sites the earlier kept
text had room for) is not where they are (the suite fills it: at
37a22599 the site's next visit, after a new site, was shown from
another slot). A site seen before 4100 others keeps its slot, its passkey
and what it stored, too. Two tabs that see a new site at once give it one
slot (one transaction reads and writes it). A page reads a site's record
the first time it shows the site, by its key, and keeps the answer while
it lives. A site seen for the first time gets an empty slot, else the slot
used longest ago in this page, and never the slot of the document the
navigation comes from when there is another: a frame of a new site is
always in another process than its embedder, and the sites that share a
process are the ones farthest apart in time. A site has the same slot as a
page, as a frame and in every tab: same-site documents of one browsing
context group reach each other synchronously, so they must be one origin.
(The fewest sites: every site a slot was ever given.)

What a navigation's read of the assignments costs, in headless Chrome 157,
ms, the medians of 15 in each of three runs (a page that drives
`SiteSlots` over one pool of five with that many sites kept; its clock
counts in 0.1 ms, as a page's that is not cross-origin isolated); each
cell is before (37a22599) / now:

| sites   | a page's first read     | a site read again | a site not read yet     | after another tab wrote | a new site               |
| ------- | ----------------------- | ----------------- | ----------------------- | ----------------------- | ------------------------ |
| 1,000   | 0.3 to 0.4 / 0.3 to 0.5 | 0.1 / 0           | 0.1 to 0.2 / 0.3 to 0.4 | 0.3 to 0.4 / 0.2 to 0.3 | 0.5 to 0.6 / 0.4 to 0.7  |
| 10,000  | 4.3 to 4.4 / 0.3 to 0.5 | 2.0 to 2.2 / 0    | 1.7 to 2.3 / 0.2 to 0.4 | 4.6 to 5.4 / 0.3 to 0.4 | 7.6 to 10.6 / 0.5 to 0.8 |
| 100,000 | 64 to 71 / 0.4 to 1.1   | 34 to 37 / 0      | 33 to 38 / 0.2 to 0.5   | 73 to 92 / 0.2 to 0.4   | 97 to 131 / 0.4 to 0.7   |

Before, every navigation copied the whole text out of localStorage,
compared it with the one read last and made a map of every site from
it, and a new site wrote the whole text back. The first page of this
build reads the text an earlier build kept (every pool's, each site's
slots newest first) into the database once, and removes it: 48 to 66 ms
for 1,000 sites, 0.2 to 0.4 s for 10,000, 1.7 to 2.7 s for 100,000, which
that page's first navigation waits for. A page of an earlier build that
writes the text again is read in by the next page. The slot that took a
navigation last (`last-site-slot`, Spares) stays in localStorage: a hint,
not where data is.

**Hub and agents** (src/controller/sites.ts, site.ts). The host's controller
is the hub and keeps its own worker, transport and API. For each slot in
use it embeds an agent, `controllerFrame.html?script=siteFrame.js` on the
slot's origin, which registers that origin's service worker (the same
script, scope and codec key) and runs a controller there with the hub's id
and options: handshakes, revives, the SW_KICK of a spinning page (the
agent is same-origin with the slot's pages) and the slot's emulated service
workers are the agent's. A slot is started the first time a site is shown
from it, or before, as a spare (What it costs). What the hub's host changes later for its worker (rules, shields,
the blocker's lists, a cleared cache, a site's storage to forget) is told
to every agent.

**One transport, one jar.** Every port an agent would serve the transport
on is posted to the hub's transport worker, and so is the port of the
slot's cookie jar: cookies are not a site's own (a page of one site sends
another's with its requests, and a response to it sets them), so every
slot's worker asks the host origin's one jar database over a MessagePort
(src/server/jarDB.ts; the jar asks six things of its database and keeps
nothing between them). The transport worker answers
(src/transport/jarServer.ts): a thread of the host's origin that lives as
long as the host's page and is never the thread a proxied page spins. A
change is told to the other slots' workers, whose documents drop what they
kept of `document.cookie`. Nothing else is shared, and with a site that
keeps its slot nothing else has to be: every other store is keyed by the
document's own site (and its top-level site), which is always asked from
the same slot.

**Routing** is unchanged in pages and the rewriters: every route is relative
to the document's own origin. A navigation to a document of a site that
another slot shows is answered by the worker with a 307 to the same route
on that slot's origin, once the hub has that slot's agent and worker up and
has handed the target worker what the first one knew of the navigation
(the routed referrer and policy, the document's navigation hint, the
redirect chain). The worker asks the hub for a site's slot once and keeps
the answer. `frame.go()` asks the hub and navigates there directly. Every
document a slot's worker serves carries `Origin-Agent-Cluster: ?1`, and so
must everything the server answers on a slot's origin: an origin's keying
is decided by its first document in the tab, and the first is the agent.

**The proxy's other origins.** Every thread of the pool (the hub's
worker and page, each slot's worker, every document and worker they serve)
knows every origin of the pool as the proxy's own (`proxyOrigins` in
src/routeURL.ts: a slot's `Config.sites`, the hub and every slot; the
hub's `Config.slotOrigins`, which is not `sites` because the hub's worker
also serves documents of its own origin, which are no slot's). A route on
any of them is a route: a hook handed a slot's raw URL unwraps it as it
does one of its own origin, a
navigation to a route of a route (a page's raw slot URL routed on the
hub's origin) is redirected by the worker that gets it to the inner route,
on the inner route's origin, and `controller.unroute()` reads a route of
any slot (a host reading `frame`'s routed URL off a slot). Any other URL
of them is a site like another (docs/proxyception.md): it goes out over the
transport, so what answers is the host's server as any client sees it,
never a worker or a page of the pool, and a navigation to it is shown from
a slot of its own (leaveSlot). None of this makes
another slot same-origin to a document: the emulated same-origin policy
still compares the real origins.

**Windows and messages.** A window of another slot is the browser's own
WindowProxy, restricted by the browser, and the membrane still hands the
page its stand-in for it, as without a pool (the frame may next show a site
of the page's own slot, "Threat model"); the hub's page is hidden (`top`,
`parent`, `opener` and `event.source` stop below it). A message to it goes to `*` in an envelope
with the sender's origin, the origin it is for and the hub's token; the
receiver delivers it as from that origin when it is for its own, and drops
it otherwise. A window of the same slot may still be another site's (sites
that share a slot): the membrane decides as it does without a pool.
A link, a form or `window.open()` a frame aims at `_top` or `_parent`
when that window is another slot's goes the same way: the frame's inject
(DocumentClient `targetAcross`, `navigateAcross`) posts the URL, or the
form's attributes and entry list, in an envelope with the hub's token,
and the receiver's inject, when the sender is a frame under it, navigates
itself as the frame's would have navigated it in one origin.

**History.** A page's `history.back()` past its own slot's entries is the
browser's step. The hub's `frame.back()`, `forward()`, `reload()`,
`canGoBack` and `canGoForward` act as a tab's do (Back and Forward, below);
`frame.url` comes from the pages' reports.

## Back and Forward

A tab's Back and Forward step its whole history, the frames in its page
included, and pass over the entries Chrome's history intervention skips
(src/controller/history.ts). Without the pool the host reads all of it
through the Navigation API of the frame's documents, which are of its own
origin. Under the pool the browser lists a document the entries of its own
origin only (`navigation.entries()` is the stretch of the frame's history
shown from its slot), and the hub reads none of them.

So the frame's history is a list of runs, each a stretch of it shown from
one slot (`Frame` in src/controller/index.ts). The agent of a run's slot
keeps the run's states as the single-origin controller keeps a frame's
(`answerRun`, one history per run): the hub hands it every report of the
frame's document, of a frame in its page (its path of frame indices; a
document of another slot than its page's adds its own entry's key, id and
address, which the agent cannot read, from Navigation API getters taken
before page code ran) and of a user activation, and the agent answers with
the run's states, which of them Back passes over and where the frame is.
The hub composes the runs: Back goes to the nearest earlier state that is
not passed over, in this run or one before it, and is off when there is
none; Forward the same way.

A step within a run is the agent's, a traversal of the frame's navigable as
without the pool. A step to another run is the browser's own: the agent of
the frame's slot calls its realm's `History.prototype.go` on the frame's
window with the number of steps of the joint session history between the
two states, so the frame lands on the entry the browser kept, and nothing
of the slot it leaves stays reachable (a `location.replace` there left the
slot's earlier entries in the history, where a page's own Back found them:
Back was on where Chrome's is off). The count holds while every step between
is an entry of the joint history (a frame's first document in a fresh
browsing context makes none) and no other frame of the host changed the
joint history since (another tab: the traversal would move that one too,
and Forward finds the entries gone). Otherwise the step is a
`location.replace` to the state's address, which the agent of the run it
lands in takes for that state, as history.ts does within a frame.

When the frame leaves a run for a new one, the run's later states are gone,
and the document that sent the frame on by itself is passed over unless it
had a user activation of its own (none crosses origins, natively as here);
one the host sent elsewhere (a typed URL) is not. A document that replaced
itself with another slot's (`location.replace`) took its entry with it: the
new document's report says how the browser navigated to it
(`navigation.activation.navigationType`), and the run before loses the
states of that entry (and goes, when they were all it had; the runs either
side of it are then one origin's, which the browser lists as one stretch).

toolbar-history compares every sequence with a tab of its own: with the pool
27 of its 38 checks passed before (the agent heard no report, the buttons
were the page's own, and the step across slots replaced); now every one
does, in Chrome 152 and 156, and so do three new sequences that failed
before: two tabs of two sites browsed in turn, and a page (the first one,
and a later one) that replaces itself with another site's.

Left as they are:

- Runs merged after a replace keep the later run's view of the earlier
  one's entries, the frame's own navigable's: steps a frame in the earlier
  run's pages took, and which of its states Back passed over, are gone.
- A frame in the page that shows another slot's document is stepped by a
  `location.replace` of its window: its entries are of another origin than
  the page's agent, and only that slot's agent could traverse them.
- Whether another frame moved the joint history is told per run, not per
  state: a step to an earlier run after another tab moved anything since
  that run began is taken in place.

## A page's Content-Security-Policy

The browser judges the 307 to another slot by its copy of the page's
policy (docs/csp.md), where only the document's own slot is `'self'`. So
for a document shown from a slot the browser's frame-src,
fenced-frame-src and form-action (a page's child-src or default-src
included, the Guardian's `child-src https:`) name every slot of the pool
as well, wherever the page's list lets any URL through. Before, every
frame of another slot on such a page was refused (ERR_BLOCKED_BY_CSP)
with a violation naming the slot's origin; natively and with one origin
they all load. The page's own policy stays the inject's and the worker's,
judged by real URLs before the hop. A redirect's hop that leaves a slot
is judged by the worker it leaves, which the documents of the navigation
told its policies (the form-action and the parent's frame-src): a refused
one goes to a refusal URL, as without a pool, and a report-only refusal is
reported to those documents. What they told goes on to the next slot's
worker with the navigation, with a frame's real ancestors, so the later
hops are judged there and a document's frame-ancestors is judged against
its real ancestors whichever slots they are in. A frame whose parent is a
document of another slot cannot reach it: the worker that serves the
frame hands it the parent's frame-src and the ancestors it was told
(ScriptFacts `framed`), and a navigation the frame starts itself is judged
by them, a refused one sent to a URL whose host names it (namedRefusal),
which the parent's browser frame-src refuses and the parent's inject
reads back, so the parent gets Chrome's event. A host that gives `frameAncestors` gets the hub's origin and the
slots added to the proxy's own frame-ancestors on a slot's documents. A
violation names the page's URLs: a route of another slot is read as its
real URL, and no field names a slot (site-pool suite, `csp:` checks,
native against the pool).

Not as natively yet: a report-only refusal is not reported where the one
who would report it is of another slot than the documents whose policy
it is: a later hop judged after the navigation crossed slots (that worker
cannot reach a client of the first slot's origin), and a navigation a
frame starts itself under a parent of another slot (the parent's inject
would have to dispatch it). A navigation's policies reach the first
slot's worker in the document's NAVIGATION_HINT, which may trail the
navigation; one that is not there when the navigation leaves the slot
goes on without them (its hops unjudged, a frame's ancestors its top's
alone).

## Focus and cross-origin isolation

**Focus.** Every proxied top of the pool commits in a process of its own:
the frame's initial about:blank is the host's, and a site of another slot
is another origin. Chrome keeps a focused frame focused across such a
commit, and sends the new document the keys typed next, but the new
process never hears that its frame has focus, so the document reads
`document.hasFocus()` false (natively a frame of a page has that fate,
which the focus-navigation suite shows; a tab's page does not). The hub
tells every agent which of its frames has focus (`SiteHub` `#focused`,
by focusin and focusout), the agent keeps that frame's window, and a top
document of the slot reads it as it starts (`keepTopFocus`,
src/inject/dom/siteWindows.ts): when it is its own frame it asks the
browser for focus, which already gives it that frame, before any of the
page's listeners exist, so the page sees no focus event and never takes
focus from the host's controls. Measured in the focus-navigation suite
against Chrome's own: after a typed navigation, to another site, a link
to another site and `frame.go()`, `hasFocus()` true, `activeElement` the
body, no focus or blur event, the keys reach the page (before: false);
a frame of another site in the page takes and gives back focus as
natively (the top's `hasFocus()` stays true while its frame has it).

**Autofocus.** Chrome runs autofocus for a tab's top document only, the
host's: a candidate in the proxied top is dropped because the host's
address bar has the focus, and in isolation mode refused outright as a
cross-origin subframe's. The proxied top flushes its own candidates
instead (src/inject/dom/autofocus.ts, on the Navigate module's
observer), as HTML's flush autofocus candidates does for a top: at a
rendering update, once per document, nothing when something has the
focus or the document is at a fragment's target, after its style
sheets, the first candidate that takes the focus (focus suite, a parsed
and an inserted candidate, both modes). A frame of the page has no such
flush (natively one of the top's origin has its candidates flushed).

**Cross-origin isolation.** In a cross-origin isolated host page the
`cross-origin-isolated` permission reaches a frame of another origin only
when the frame's `allow` names it. The hub's `Frame` adds
`cross-origin-isolated 'self'` and every slot's origin to what the host
allows the frame (as `RemoteController` does for its proxy origin), so a
page whose own headers isolate it is isolated from any slot. A page's own
frame of another site is another slot's, which an allowlist of the real
origins (or `'src'`, the route's origin) does not reach: the browser is
told `cross-origin-isolated *` instead (an allowlist of `'none'` alone
is kept; every other feature of a page's `allow` alike, Permissions and
client hints below), the page reads its own value back, and whom the
page's allowlist reaches is in the frame's route, by which the service
worker serves every document that is not isolated natively with
`Permissions-Policy: cross-origin-isolated=()` (src/isolation.ts), as
without a pool. The cross-origin-isolation suite passes with the pool as
without (160 checks failed before).

## The proxy's redirects under the isolated host

Under the isolated host every proxied document of the pool has an embedder
policy (the worker serves it with COEP `credentialless`, as without a
pool), and a frame of another site is a frame of another origin in it.
Chrome checks a frame's navigation response against its parent's policy,
and a redirect on the way as well: without a Cross-Origin-Resource-Policy
that lets the parent have it, the frame gets the error page (measured,
CDP `blockedReason`
`corp-not-same-origin-after-defaulted-to-same-origin-by-coep`). Without a
pool every such redirect was of the parent's own origin, which needs none.
With it, the redirects a frame of another slot meets are its own slot's:
a link route's (src/visited.ts; a script's `location.href` and a link go
through one), whose answer the worker made outside a controller and so
without the headers `isolatedHost` adds, and the ones that send a
navigation between a slot and the hub's origin (`toHub`, the
`~home/` mark), which a worker may answer without knowing any controller.
The first is now answered as any other under an isolated controller of its
scope, the second always carries `Cross-Origin-Resource-Policy:
cross-origin` (it reaches no page). The site-pool-coep suite drives the
demo's own pool under the isolated host against Chrome: a frame of another
site going to another page of its site and back to its page's by
`location.href`, a link and a form.

## The documents above a frame of another slot

Without a pool the worker that serves a frame's navigation served the
frame's parent and its main frame too, and judges the navigation by them;
with it, a frame of a site another slot shows is served by that slot's
worker, which served neither. What one origin's worker knew goes with the
navigation (`SiteArrival.context`, src/server/siteContext.ts), and the
worker it arrives at keeps it as if it had served those documents, so the
frame's later navigations find it too:

- the client hints documents of the parent and of the main frame
  (src/server/clientHints.ts `departingHints`): each one's permissions
  policy, its `delegate-ch` and the features it may use, which give the
  frame its hints, the features its document may use (the permission
  states it reads, its `sync-xhr`) and the Permissions-Policy it is served
  with; and the main frame's accepted hints and viewport;
- whether the parent upgrades insecure requests.

Mixed content is judged before the navigation leaves
(`departingMixedContent` in src/server/rewrites.ts): the parent that asked
for it is a client of the first worker, which tells it the console's
notices; a blocked frame stays where it was, an upgraded one goes to its
https route (often the parent's own slot). A form's route is never sent to
another slot: the slot of the document that submitted it answers it
(the insecure form interstitial, the link route of a GET form) and its
redirect to the document's route is what leaves.

The browser's own policy: a slot is another origin than the host's page
to the browser, and than a parent of another slot, so the features whose
default allowlist is `self` (the camera, the microphone, geolocation,
WebAuthn's create and get, speaker selection) reach a slot's document only
when its frame element delegates them. The hub's frame (`Frame.go`) adds
the slots to every feature the host's `allow` gives a frame of the host's
origin, and delegates them each feature the host's page has that the
attribute does not name, as the proxied top inherits it without a pool
(src/controller/sitePool.ts `slotAllow`). A page's iframe in a slot has
the browser read its `allow` with every feature it names delegated to any
origin, but one it gives nobody (the page reads its own value); the
frame's document is then served with the policy the page's attribute
gives its real origin, as without a pool. A frame without an `allow`
attribute keeps none, which is what a frame of another site has natively.

The size of a host frame about to navigate (its top-level navigation's
viewport hints) is told to the slot it goes to before it goes. Cleared
cookies of a host take the device ids every slot's worker keeps for that
host's origins with them. The sites' permission states are the host
origin's one database, asked over the jar's port as the cookie jar is
(src/server/jarDB.ts `PERMISSIONS_STORE`), read anew for each question: a
frame's permission is its top's, and the frame may be shown from another
slot. The devices a site chose are kept there too (`DEVICE_GRANTS_STORE`):
Chrome keeps a chosen device for the top-level origin, which is the
host's for every slot, so one slot's `forget()` takes the device from
every slot, and only the one store knows whether another site still holds
it (bluetooth-grants: with a store of each slot's own, site B's `forget()`
took site A's device away). The hub's own worker keeps its copy in memory,
so a site shown from the hub's origin (a page that fell back to single
origin) reads what it read last.

**The request log.** An agent's worker reports each request to the hub,
which gives it its frame as for its own (the documents tell the hub which
client they are). A document shown from a slot is a client of that slot's
worker, which the hub's own worker never knows of: when the hub asks which
of the clients it keeps are gone, it asks its worker and then every started
slot's agent, and only a client none of them knows is gone. Asking its own
worker only, it forgot a slot's documents as soon as it asked, and a
quarter of their requests (request-clients, 200 visits: 150 to 152 with
their frame) and every later fetch of a page's service worker reached the
log late or with no frame.

**Passkeys** (docs/passkeys.md). A slot's worker is the passkey
authenticator of the sites it shows, as the hub's is of its own: it checks
who asks from the sender's route, makes and signs. It keeps the keys where
the hub's worker does, in `stompPasskeys` on the hub's origin, asked over
the jar's port as the permission states are (src/server/jarDB.ts,
src/transport/jarServer.ts; a non-extractable `CryptoKey` crosses a
`MessagePort` as itself): a credential is the user's, and natively
outlives anything short of the user deleting it, so it must not depend on
which slot shows its site. The hub hands each agent its passkeys
option (`SiteAgentInit.passkeys`), and the agent's controller gives every
prompt to the hub (`passkeyRelay`, `HubBound.passkeyPrompt`), whose host
asks the user with the frame the document is in, as for its own sites.
Chrome lets a frame ask while the focus is anywhere in its top's page, and
a slot's worker has no client of a top shown from another slot: when none
of its own clients has the focus it asks the hub
(`passkeyFocused`), which answers whether the focus is in the frame of the
host's page that shows the document (through its host in isolation mode).
`controller.passkeys` and `forgetStorage` reach the one store through the
hub's worker. The passkeys suite passes with the pool on, in both modes
(site-pool-passkeys runs it so), and site-pool-kept-sites shows a site
shown from another slot than the one it registered from still signing in.

## Popups under the isolated host

With the pool every proxied page is a frame of another origin than the
host's page (its slot's), and the isolated host (STOMP_ISOLATION on,
production's default) sends COOP `same-origin` with COEP. Under such a top
Chrome gives a frame of another origin than it null from `window.open`,
about:blank included, and opens its popups without an opener (measured in
Chrome 152, 156 and 157). So a proxied page that opens a blank window and
then sends it somewhere, which is how many sign-in popups start, gets null
and no opener to answer; a sandboxed frame's popups have no opener either.
The demo takes `window.open(url)` and `target=_blank` links as tabs of its
own, so those return null in every mode, pool or not. Without the pool, or
with the host not isolated, none of this happens (popup-openers; its known
list names the cases).

No COOP value keeps both. Measured with a kit (the host page with COEP
`credentialless` and CORP, a frame of another origin with what a slot's
document has; Chrome 157.0.8103.50, the same in 152 and 156):

| the host page sends                                                   | isolated | clock  | its frame's `window.open('')` and `(url)` |
| --------------------------------------------------------------------- | -------- | ------ | ----------------------------------------- |
| COOP `same-origin` (the isolated host)                                | yes      | 5 us   | null                                      |
| COOP `same-origin-allow-popups`                                       | no       | 100 us | windows, with their opener                |
| COOP `noopener-allow-popups`                                          | no       | 100 us | windows, with their opener                |
| `Document-Isolation-Policy`, COOP `same-origin-allow-popups`, no COEP | yes      | 5 us   | windows, with their opener                |

Only COOP `same-origin` makes a page cross-origin isolated, and that is
the value that takes the frames' popups away. A
`Document-Isolation-Policy` isolates the page by itself (Chrome 137 and
later on desktop, 146 on Android; not Firefox or Safari), and is the
follow-up that fixes this.

## COOP across slots

A page's Cross-Origin-Opener-Policy is emulated as without the pool
(src/coop.ts): the worker that serves a top-level document decides, from
the facts the navigation's hint told, whether it leaves its browsing
context group, and gives the browser a real policy that makes it so.
With the pool the hint reaches the worker of the slot the navigation
leaves, and the facts go on with it to the slot it arrives at
(SiteArrival `chain.coop`, with a frame's csp attribute's `required`
policy beside it). Chrome keeps a group under COOP `same-origin` only
between documents of one real origin, and each slot is an origin of its
own: a window the browser holds that policy for, sent to a site of
another slot by a navigation that natively keeps its group (the document
sends no policy), would leave the group there whatever header it got.
Such a navigation is served from the window's own slot
(serviceWorker.ts leaveSlot), as a site that shares a slot is, so no
real header severs a pair that Chrome keeps connected. A frame of another
slot than a top with COOP `same-origin` opens its popups without an
opener, as natively, from what its route says of the top (nestedMark
`o`, dom/openerFacts.ts opensWithoutOpener). Under the isolated host,
where every popup is kept in the host's group by the COOP it is served
with, one that natively leaves its opener's group is served without it
(src/isolation.ts isolationResponseHeaders, `severed`), with the pool as
without it.

## A frame's sandbox across slots

A frame of another slot than its parent cannot read its frame element,
and the inject emulates the sandbox from the element's attribute (the
real one keeps `allow-same-origin` and `allow-scripts` so the service
worker serves the frame and the inject runs, src/inject/dom/sandbox.ts).
So such a frame had no sandbox at all: sandboxed without `allow-scripts`
it ran its scripts, with `allow-scripts` alone it read its own origin and
its storage, a frame in it inherited nothing, and its `window.open(url)`
and links went to the host as tabs. The parent now puts the frame's
sandbox (its attribute with the parent's own flags) in the frame's route
(src/partition.ts nestedMark, `~` and the tokens), and the frame takes it
from there when its element is out of reach; a navigation of the frame's
own keeps it. site-pool-sandbox compares with Chrome, in both hosts:

| a frame of another site                       | natively                      | before, with the pool    | now         |
| --------------------------------------------- | ----------------------------- | ------------------------ | ----------- |
| sandboxed without `allow-scripts`             | runs no script                | runs its script          | as natively |
| with `allow-scripts` alone                    | origin `null`, storage throws | its origin, storage read | as natively |
| a frame in that one (of the other site again) | the same                      | its origin, storage read | as natively |
| `allow-popups`: `window.open(url)`            | a window, its opener          | null (a host tab)        | as natively |
| `allow-popups`: a link with `rel=opener`      | a popup, its opener           | a host tab               | as natively |

Under the isolated host the last two rows are null and no opener before
and now: Chrome gives a frame of another origin than a top with COOP
`same-origin` no window for its popups, and with the pool every proxied
page is such a frame. Without the pool the popups of these two rows lose
their opener under the isolated host too: a sandboxed frame's origin is
opaque, so it is another origin than the top's as well.

## A frame's script that navigates an ancestor of another slot

A frame that sets `top.location`, `top.location.href` or
`parent.location`, or calls `top.location.replace()`, is refused or let
through by the Context module as Chrome's LocalFrame::CanNavigate decides
(docs/same-origin-policy.md), and the target window then navigates itself
through its own Location (its route, its history entry, or none for
`replace`). When the target is an ancestor of another slot, the frame has
no client of it to ask, and before this the call went to the browser,
which refused it for the host's sandbox: every such case threw a
SecurityError (or navigated nothing) where Chrome navigates the top, and
Chrome's own console line named the slot's routed URLs.

The decision stays in the frame and synchronous, from what the frame
knows of the target without reaching it (siteAcross.ts `ancestorAcross`):
whether it is the proxied top (`siteTop`), its origin (the top's from the
frame's route, `topOrigin`; another ancestor's from `ancestorOrigins`),
and whether the frame reaches it or a window above it (by the browser's
own `parent`, which reads across origins). A sandboxed frame decides by its
sandbox as it has it (its route's tokens when its element is of another
slot: `mayNavigate` now takes the proxied top of another slot for the
top), so a frame without `allow-top-navigation` is still refused, with
Chrome's message. The refusals (the framebusting intervention, a sandbox's,
"neither same-origin with the target...") throw Chrome's SecurityError in
the frame, and a read of the top's `location.href` or `assign` still
throws as the browser's own.

A navigation let through goes across in the pool's envelope (`kind:
'location'`, with `replace`): the frame first asks its own worker what it
would record of itself as the initiator (INITIATOR_ROUTE with `ask`: its
routed URL, '' when opaque, and the referrer policy the browser gave its
request), the target, when the sender is a frame under it, tells its own
worker those facts (the route read as the same route on its origin, the
origin parsed from it; a URL off the pool's origins is refused), and then
navigates itself. Each step is bounded at 1 s, so a worker that does not
answer delays the navigation that long at most, and nothing starts in the
frame's own task. A frame of another slot is another site than the
target, so Sec-Fetch-User is never sent, as natively. When the
destination is a site of a third slot (a frame of B sending the top of A
to B), the target's worker hands the initiator on with the 307
(`SiteArrival.initiator`), so the document arrives with the frame's
Referer and Sec-Fetch-Site. Only http(s) URLs go across; another scheme
the frame may use is refused by the browser, as before.

top-navigation, with the pool on, compares with Chrome 157: none of its
66 cases differs in either half, where 48 differed in each (the suite as
it is now, at the commit before; the history.length a landed document
reads at its first script among them, below under "Isolation mode's
halves of the suites").

## Just call stomp on the slots

Just call stomp (src/controller/justCallStomp.ts) never navigates a frame
to a site: each document is written into a fresh frame of one call page
the worker serves (`<directory><callPage>`, docs/dialing.md). With a pool, every slot's worker
serves that page on its own origin, and a site's documents are written
into call pages of its slot. So a site is another origin, process,
storage and worker than the host's page and every other slot's, as the
pool's navigations are, and the host's page (the demo's UI) is never the
thread a proxied page runs on. The slots, their assignment, the spares,
the fallback and the agents are the pool's own: a controller with
`sitePool: { origins }` and `justCallStomp(frame, url)` is all it takes.

**Where a call is made.** From the origin the navigation would have
begun on: the origin of its referrer (the route of the document it
leaves), whose worker knows what that document told it (its hint, its
policies, the redirect chain), or, with no referrer (a typed URL, a
reload of the first entry), the site's slot, as `frame.go()` picks it.
The worker answers the call as the frame's navigation, leaveSlot
included. When the site is another slot's, leaveSlot hands that slot's
worker the arrival and answers 307, which a fetch would follow to an
origin whose worker does not control the call page, so the call's
answer is a 204 with `x-stomp-call-moved` naming the route there
(src/server/called.ts). The host removes that frame and calls again from
a fresh call page of the slot it names, with no referrer of its own (the
arrival carries it) and a fresh token, which the hub mints and hands that
slot's worker through its agent (a token is good on the origin it was
given to only). The same goes for a redirect chain that crosses
slots, at most eight times.

**Nested frames.** A called document is the host of its frames' calls
(src/inject/dom/calledFrames.ts). A frame the page sends somewhere is
first called from the page's own slot (its call page, `<callPage>?1`
there); a frame of the page's own site stays there, one of another site
is answered as moved, and the page sends the frame to that slot's call
page with `location.replace` (which a window of another origin takes and
which makes no history entry) and calls it from there. The page's realm
cannot read such a frame's location, so the frame is followed by what was
done to it, and a page's message to it before its call is dropped as to
any call page. Its next documents are called from the origin of its own
document, and move again as needed.

**What the browser sees**, measured in the jcs-slots suite against Chrome
157 (a page of 127.0.0.1 with a frame of localhost):

| observation                                           | natively | one origin | slots  |
| ----------------------------------------------------- | -------- | ---------- | ------ |
| frame of another site, timers under a 300 ms spin     | 5 ms     | 301 ms     | 5-6 ms |
| frame of the page's site, same                        | 300 ms   | 301 ms     | 300 ms |
| message to the frame of another site and back, median | 0.3 ms   | 0.1 ms     | 0.4 ms |
| the other slot's frame reads the page's localStorage  | no       | yes        | no     |
| the page reads the other site's document or location  | no       | (emulated) | no     |

Every frame's `src` and real location is a call page of its site's slot;
a link to another site lands on that site's slot with Chrome's Referer
and fetch metadata; Back writes the first page on its slot again; the
host's history.length does not move.

**The host's own thread.** The point of a content origin for the demo is
its UI: in one origin a heavy page is the UI's main thread. With a page
spinning 200 ms of every 250 in a tab, the host's key input waited 141 to
148 ms (p95) and its animation frames came every 183 to 200 ms (p95, 16
over 100 ms in 4 s) in one origin, and 2 to 10 ms and 17 ms (none over
100 ms) from any number of slots, one included.

**Every mode side by side** (Chrome 157, one fresh browser a mode; a page
of 127.0.0.1 with a frame of localhost; the busy page in a tab of its
own; MB is the Pss of every Chrome process, idle, then with one site and
with two):

| mode                 | MB            | other site's timers | shares raw storage | key input p95, busy tab | frames over 50 ms in 6 s |
| -------------------- | ------------- | ------------------- | ------------------ | ----------------------- | ------------------------ |
| Chrome, no proxy     | 162, 171, 190 | 8 ms                | no                 | 153 ms                  | 24                       |
| navigated            | 348, 401, 417 | 300 ms              | yes                | 157 ms                  | 24                       |
| navigated, 3 slots   | 592, 694, 658 | 5 ms                | no                 | 2 ms                    | 0                        |
| called               | 417, 468, 486 | 300 ms              | yes                | 155 ms                  | 24                       |
| called, 3 slots      | 479, 592, 675 | 5 ms                | no                 | 1 ms                    | 0                        |
| called, content port | 475, 452, 485 | 300 ms              | yes                | 1 ms                    | 0                        |

Chrome itself holds the UI to the busy page when the page is of the UI's
own origin (the first row), so the UI's own origin is the wrong place for
any page. One content port (the last row) frees the UI as the slots do,
and keeps the sites in one process among themselves.

**How many slots** (Chrome 157, headless, machine load about 35; two
runs each; twelve tabs of twelve sites opened one after another, then a
thirteenth site):

| slots | first page | each site's first page, median | 13th site | MB idle | MB, 12 sites | renderers | UI input p95 |
| ----- | ---------- | ------------------------------ | --------- | ------- | ------------ | --------- | ------------ |
| none  | 326-380 ms | 190-219 ms                     | 185-202   | 394-404 | 461-473      | 3         | 145-148 ms   |
| 1     | 515-529    | 189-242                        | 198-260   | 462-482 | 544-561      | 4         | 2-4 ms       |
| 5     | 586-687    | 194-212                        | 178-252   | 509-537 | 816-826      | 8         | 2-9 ms       |
| 10    | 439-990    | 311-482                        | 192-193   | 527-535 | 1140-1164    | 13        | 3-4 ms       |
| 20    | 485-513    | 403-426                        | 275-286   | 524-529 | 1309-1323    | 16        | 5-6 ms       |
| 32    | 515-816    | 372-459                        | 257-313   | 510-546 | 1298-1362    | 16        | 2-10 ms      |

A slot nothing was shown from costs nothing (MB idle is flat from 5 to 32
slots: the agents start with their first site, and the page keeps one or
two spares). A slot in use costs some 65 to 70 MB with a small page in it
(its renderer with the agent, its worker's share) and its start, 0.2 to
0.3 s, which every site that is the first of its slot waits for unless a
spare took it: with more slots than sites, every new site is such a
first. Five slots keep a site's first page where one slot has it, and ten
or more do not, so five is the cap the demo recommends (DEPLOY notes in
the change). One port alone already takes the pages off the UI's thread.

**The demo.** `STOMP_SLOT_PORTS` (a list or a number of ports, as
`STOMP_SITE_POOL`; off by default) and, behind a front,
`STOMP_SLOT_PORTS_PUBLIC` are the content slots the page in dialing mode
(`?mode=just-call-stomp`) gives its controller as its pool, with
`warm: false` (a slot starts with its first site, never as a spare); the
default mode never uses them. docs/content-slots.md is the design
(assignment, laziness, fallbacks, what the ports are not) and
docs/content-slots-deploy.md what production needs.

**Fallbacks.** Where a site's slot does not answer (left out by the hub,
Fallbacks below) the call is made from the host's own origin, as the
pool's navigations fall back: a typed address, a link whose referrer's
slot went silent (the hub finds it out when it tells that slot's agent the
viewport, 4 s at most), and a move that a slot's worker sends back to the
hub (to the hub's origin, with or without the `~home` mark, which the
hub's worker takes as a call too). A frame of a called document is never
sent to the hub's origin: a frame whose site moved there stays unwritten.

**Not yet:** a cross-site step of a frame's own history goes through the
slot of the entry's referrer first (an extra call page there, then the
move); the scroll of a document on a slot is not read when it is left
(another origin; it needs the document to report it over its port), so
Back to another document starts at the top; and a slot whose port stops
answering while the hub still counts it live leaves the call waiting on
its call page (the call page's answer has no bound before the worker's
fetch is done).

## What a deployment needs

- The proxy's host answering on the pool's ports as it does on its own,
  with the certificate of the same name (a port needs none of its own), and
  `Origin-Agent-Cluster: ?1` on everything those ports answer.
- Nothing in DNS.
- Nothing else. A network that lets through the host's own port alone (a filter that
  knows port 443 only) reaches no slot: the hub asks each slot's origin
  for an answer while its agent's frame loads (5 s at most; the agent's
  hello is an answer), leaves a silent slot out, and with none shows the
  site from the host's origin, as without a pool.

## What it costs

A slot in use is a renderer process with the slot's agent in it beside
the slot's documents (some 14 MB with the agent alone: 11 MB of it is the
process and a bare document, the agent's controller about 1 MB, the
bytes of the rewriter's module it hands its worker 0.6 MB), a worker in
the one process that runs every worker of the host's site (some 5 MB a
slot: a JS heap of 2 of 3.4 MB, the rewriter's module and its instance),
and the time the agent takes to start (0.3 to 0.5 s: its frame loads, its
worker installs and shakes hands), which the first document from a slot
never used waits for. A slot's worker builds no blocker engine (below),
and keeps a share of what one worker keeps in memory between documents:
the memory cache of the proxied pages' subresources (src/server/cache.ts,
96 MB for one worker) is 96 MB divided among the slots, and the memory the
rewriter's instance keeps for the next document (64 MB for one worker) is
shared the same way, down to 16 MB a slot (a document of 500 KB or so;
past it the instance is made again for each one). The rewrite cache and
the HTTP cache are on disk, a slot origin's each. An agent compiles the
rewriter's module only when a page or an emulated worker of its slot
asks for it (a spare's never does): 1.1 MB less of renderer an agent in
Chrome 152, 2.1 MB in 156, and four agents up in 380 ms against 494
(Chrome 152; 386 against 444 in 156).

**Spares.** The hub starts, while its page is idle, the agents of the
slots a site is likely to be shown from next (SiteHub.warm): before the
page shows any site, the slot the next new site would get and the slot
that showed a site last (in any tab or visit, `last-site-slot` in the host
origin's localStorage: the site a visit often goes back to); once it
showed one, the next new site's, when no agent is idle (none of the
page's documents is from its slot). The page keeps at most one spare
then (two before its first site), and a spare is never closed (the hub
counts its frames by index in the page's `frames`, the agents' too). The
hub's probe of a slot's origin (5 s at most) runs beside its agent's
frame load instead of before it, and the agent's hello is an answer: a
slot that does not answer is found out while the page is idle, so a
navigation asked for after that is not held up by it (a slot that accepts
connections and never answers: the page from the host's origin in 0.15
s against 5.1 s before, asked 7 s after the controller was up, medians of
three in Chrome 152 and 156; asked at once, both wait out the 5 s; a port
that refuses connections takes 0.1 s either way).

What a site's first document costs, from a fresh profile, the demo page
up and idle for 3 s and then asked for a page of one site (a fixture of
127.0.0.1 with a 150 KB script and a stylesheet), medians of five, with
the machine's load at 34 to 67 (so the spread is wide: 0.26 to 0.69 s
with a spare in 152); a revisit is the same page in a profile that
showed it once before:

| first document, ms      | Chrome 152: first visit | revisit | Chrome 156: first visit | revisit |
| ----------------------- | ----------------------- | ------- | ----------------------- | ------- |
| single origin           | 301                     | 444     | 362                     | 317     |
| pool, before the spares | 813                     | 565     | 709                     | 598     |
| pool, no spare          | 717                     | 723     | 506                     | 484     |
| pool, with the spares   | 397                     | 359     | 302                     | 468     |

The site-pool suite prints the same for a controller it has just made
(about 1.1 s from a slot never used, as before): a page that asks at the
moment its controller is up waits for the controller's own start too (a
single-origin controller's first document then takes 0.8 to 1.1 s as
well), and the spare races the request. From a slot the controller
started as its spare while the page was idle it prints 0.13 to 0.27 s.

What the browser's processes take and do, with the default lists (a
local copy), for a page of one site and a page of five (a top and four
frames of other sites, the fixture above), fresh profiles, medians of
three, with the machine's load at 23 to 51 (152) and 25 to 44 (156):
the sum of the proportional set size of every Chrome process 15 s after
the page was asked for and 30 s later, the CPU time of all of them over the first 15 s and the 30 s
after that (100% is one core), and when the last document loaded.
"Before" is the pool as it was before the spares (thin slots, the agent
compiling its module, the probe first):

| Chrome 152                     | natively   | single origin | pool before | pool now    |
| ------------------------------ | ---------- | ------------- | ----------- | ----------- |
| one site: MB at 15 s, 45 s     | 254, 243   | 458, 349      | 479, 384    | 512, 408    |
| one site: CPU, idle CPU        | 5.6%, 0.3% | 4.9%, 0.7%    | 7.0%, 0.9%  | 6.7%, 0.9%  |
| one site: document loaded      | 0.17 s     | 0.39 s        | 0.79 s      | 0.34 s      |
| five sites: MB at 15 s, 45 s   | 308, 294   | 455, 383      | 689, 534    | 697, 533    |
| five sites: CPU, idle CPU      | 7.9%, 0.3% | 9.6%, 1.0%    | 21.2%, 1.7% | 20.2%, 1.8% |
| five sites: last document      | 0.29 s     | 0.67 s        | 1.9 s       | 1.3 s       |
| worker process, five sites, MB | -          | 138           | 150         | 149         |

| Chrome 156                     | natively   | single origin | pool before | pool now    |
| ------------------------------ | ---------- | ------------- | ----------- | ----------- |
| one site: MB at 15 s, 45 s     | 202, 194   | 404, 303      | 428, 326    | 453, 355    |
| one site: CPU, idle CPU        | 2.5%, 0.7% | 3.8%, 1.1%    | 5.5%, 1.1%  | 5.6%, 1.1%  |
| one site: document loaded      | 0.18 s     | 0.34 s        | 0.71 s      | 0.39 s      |
| five sites: MB at 15 s, 45 s   | 253, 252   | 402, 335      | 642, 505    | 659, 505    |
| five sites: CPU, idle CPU      | 5.3%, 0.6% | 8.6%, 1.4%    | 19.5%, 1.9% | 18.6%, 2.1% |
| five sites: last document      | 0.35 s     | 0.75 s        | 1.5 s       | 1.3 s       |
| worker process, five sites, MB | -          | 141           | 155         | 155         |

On a page that shows one site the spare is the one cost that grew: 24 MB
in Chrome 152 and 29 MB in 156 (an agent's renderer and its worker) the
page never uses, and no CPU once it is up (the same idle CPU either way).
It is what takes the next new site's first document (a link to another
site, a frame of one that appears later) from the slot's start, as it
took the first site's (0.79 to 0.34 s above, 0.71 to 0.39 s in 156). It
is worth its memory: a page of one site takes 17% more than with the
single-origin controller (8 to 10% before) and loads as soon, and the
pool's point is the next site. A page of five sites starts its slots at
once and has no spare left: the same memory as before, and its last
document 0.2 to 0.6 s sooner. Lighter agents were weighed and not made:
an entry that runs only what an agent needs would save the controller's
script (about 0.8 MB of the 14), and an agent that closes itself once its
worker is up would give back its process (11 MB) but come back for
everything a slot's pages need of it (a spinning page's SW_KICK, a
worker that restarted, a site's emulated service workers, the hub's
history steps) at the cost of a start each time, and the hub counts its
frames by index.

What a slot still costs is its renderer process with the agent in it
beside the site's documents, and a worker of a few MB: natively a site of
its own is a process too.

**A frame of another slot than its page's** has no proxied top in reach
(every window above it is of another origin), so it made what only a top
makes: a realm for the rewriter library, the library evaluated there and
an instance of the rewriter's module, for each such frame (an ad or a
cookie-sync frame of another site, often dozens on a page). The slot's
agent is of the frame's origin and in its process, so it makes one library
for all of them (src/controller/slotLibrary.ts), as a top makes one for
the frames under it: before it tells the hub it is ready, so before any
document of the slot exists, from the library's file its controller reads
anyway, in a realm of its own document made with the browser's methods
and removed again. It keeps a frozen object of that library and the file's
statements on its window under a name made of the client's, which it
makes for good: the light library's, and the deferred ones each by its
name (the parts', the passkey client's, the activation gates'), which a
frame asks for by name. (A frame took the text from the parts' statement
to the file's end for any of them before, and the statements
after the one it asked for became globals of its page's.) A frame of another slot finds it among the frames of the
real top, read with the browser's own getters, from the last (the agents
come after the frames that show sites), rewrites in it, and the first one
handed the controller's compiled module gives it to that library. A frame
that finds none (an agent of another build, a policy that refuses eval in
the agent) makes its own, as before. The codec stays each frame's own (a
1.4 KB module: some 76 KB of memory a frame). measure-frame-memory, 60
frames of a small page, per frame, Chrome 152 and 156 (medians of three
runs before and two after, with the machine's load at 26 to 34):

| per frame                | heap KB    | RSS KB     | its script ran at, ms | all loaded, ms |
| ------------------------ | ---------- | ---------- | --------------------- | -------------- |
| natively                 | 401, 397   | 1145, 1120 | 198 to 344            | 327 to 618     |
| proxied, the page's site | 1066       | 2630, 2610 | 1114 to 1535          | 1455 to 1936   |
| another site's, before   | 1537, 1531 | 4532, 4320 | 5330, 5416            | 7019, 7211     |
| another site's, now      | 1095, 1092 | 3132, 3063 | 1453, 1492            | 1681, 1695     |

**Its limits.** measure-frame-memory and frame-cost hold a frame to the
same ceilings with the pool on as off; what a frame of the page's site
and one of another site cost with it is in docs/frame-memory.md ("With
the site pool"). Starting a lifted
frame's watch (AnimationFrames.ts) at its first request instead of its
start would save 1.3 KB a frame and was not made: a hidden frame of the
page's origin whose first request comes after its first rendering then
gets that callback one of the top's frames late (two instead of the one
it takes natively, in both modes).

**Thin slots** (the only kind): a slot's worker builds no engine and
asks the host page's worker's over a port its agent hands it
(src/server/remoteBlocker.ts): a request's verdict, a document's cosmetic
resources (the scriptlets are rewritten in the slot), the lists' policies
for a document, the generic hide selectors and a socket's verdict. The
host's controller gives its own worker the other end (`BLOCKER_SERVE`). An
answer that does not come within 2 s is no verdict, as while an engine
loads, and a port that closed or went silent is asked for again through
the agent. Everything a worker of the slot's origin must do stays in it:
it controls the slot's documents, answers the 307 to another slot, puts
`Origin-Agent-Cluster` on its documents, takes their messages (client
ids, load channels, srcdoc vouches, permissions) and hosts the emulated
service workers of its sites. A question to the hub's worker is a
message to another thread of the same process: in a frame of a slot, a
fetch took 2.4 ms against 2.2 ms with a slot that had an engine of its
own and a navigation's first byte 6.5 ms against 6.1 (medians of 150
fetches and 50 navigations in Chrome 152; 2.3 against 2.3 and 6.6 against
6.1 in 156). A slot with an engine of its own took 1108 MB 15 s into a
first visit of the page of five sites and 649 MB 30 s later, with 48% of
a core, mostly the engine's build in each slot.

A worker that only relays every fetch to the hub's would be smaller
still (about 1 MB of heap, a tiny script, nothing to compile), but the
hub's worker would then answer for clients of another origin, which it
cannot look up, message or claim, and for requests it cannot make
(`navigate` mode), so every use of a client, `location.origin` and
`event.request` in the worker would have to be told the slot's. A bare
kit (a slot's worker that posts each request to a worker of another port,
which fetches it and hands the body back as a stream) took 0 to 0.4 ms
more for a fetch and 0.3 to 0.5 ms more to a navigation's first byte than
a slot's worker that fetches itself, at a machine load of 9 to 20; 1 to 2
ms more at 40.

What a thin slot still costs is its renderer process with the agent's
document in it beside the site's, and a worker of a few MB: natively a
site of its own is a process too.

### What the pool adds to the document bundle

The pool's code in the document bundle (`dist/injectDocument.js`, whose
size `frame-cost` holds to a budget) is what a document of a slot runs as
it starts, and what a frame of another slot than its page's runs on the
reads its scripts make first. What runs only once something has happened
is a deferred part (AGENTS.md; `src/inject/dom/siteEvents.ts` beside
`siteAcross.ts`): a frame of another slot judging its own navigation by
its parent's frame-src, a window carrying out a navigation a frame of
another slot asked of it, a violation report naming another slot's
origin, a frame's allow attribute as the browser reads it. The hooks that
call them stay in the bundle and decide there whether a call is the
pool's at all, so a document that never meets another slot evaluates no
part.

A part costs a realm its first evaluation, measured in Chrome 157 (the
frame-walk fixture, a first `cookieStore.get`): 1.1 ms and 57 KB of heap
in a slot's top (its shell loaded the text), 1.8 ms and 97 KB in a frame
of another slot (the text from its slot's agent, no request). A frame of
another slot reads `parent` and `top` and posts to its parent nearly
always (an ad frame does), so what those reads run stays in the bundle:
the stand-ins for windows of another slot (ContextModule
restrictAcross), postAcross, siteTop's answer for a window of another
origin and the ancestors past a parent of another slot
(DocumentClient.slotAncestorsPast). Deferred, every such frame would pay
the part's cost (a crazygames page has some 200): about 3 KB of heap a
frame for the stand-in and the post, when they were a part of
`siteAcross.ts` (frame-cost's frames that read their parent). The
site-pool-refusals suite takes the parts from every slot of a pool (each
serves the library's file with a parts statement that throws): such a
frame's reads and posts answer as natively all the same, while a link, a
form and a navigation aimed at a window of another slot refuse.

A frame compiles what it runs: a function a document calls once costs
that document its bytecode, however early it returns. So the pool's code
in the bundle is entered only once the document has a pool
(`client.sites`), and a document of a slot whose parent is in reach
enters none of what reads across: a slot's share and mark are read
apart from the getters every document asks (DocumentClient
`#slotShared`, `#slotMarkOf`), the frame facts the worker gives a frame
of a slot are checked when first read (Client `framed`), and a frame
decides whether its animation frames are lifted at its first request.
Measured with Chrome's precise coverage of a frame's start (the
frame-memory page, one child), a frame without the pool runs none of the
pool's functions, and one of the page's slot runs about 2.4 KB of their
source.

### A read of another slot's window

Every window of another slot reaches the page as a stand-in (Threat
model), and every read of one is the Context module's to answer, as a
read of another site's window is without a pool. Each read asked the
real window a question the browser refuses for another origin (whether
it runs STomp, its frame element, its ancestors' origins, whether it is
a window at all) and caught the SecurityError: some four exceptions a
read at about 3 us each. `window.parent.top === window.top` from a frame
of another slot than its parent cost 22 to 30 us (frame-walk: 108 to 149
ms for 5000 reads in Chrome 157, 2 ms natively, 21 ms without a pool).
The membrane now asks first whether the window is one it may not read,
by its prototype: the browser answers null for a window of another
origin (CrossOriginGetPrototypeOf), without an exception, and a window
of the page's own origin always has one (`foreignWindow`,
src/inject/dom/siteWindows.ts). A window of another origin goes the way
the refusal sent it, so every answer is the one it was; only the
exception is gone. The top of the proxied world a window of this origin
answers (`siteTop`) is kept per window, since a frame keeps its place in
the tree while it is in it, and checked against the browser's `parent`
of that window, which a window whose frame is gone answers with null;
it is still handed out through the membrane on every read. The same read
costs 2 to 3.5 us now (11 to 17 ms for 5000 in Chrome 157, 2 ms natively). Left: a
computed read that lands on a window of another slot (`frames[i]`)
still asks whether the value is a window at all, which throws for a
window of another origin, before the membrane answers it (about 6 us,
0.3 natively). The question is asked of every object a computed read
lands on, and the one exception-free answer (a list of the windows seen)
would cost every other read a lookup.

## Fallbacks

Where a slot cannot show sites, the hub shows them from its own page's
origin, as the single-origin controller does: per page, silently (a
console warning, nothing a proxied page can see), and only for the sites
of that slot. A slot left out stays out while the page lives, and the
sites it was given keep it (their records are not rewritten): their
data is there, and the next page asks the slot again. The hub's worker
routes as a slot's does: a navigation to a document on the hub's own
origin (a page that holds a proxy URL, a link of the hub's origin, a
fallback's navigation) leaves with a 307 for its site's slot when that
slot is up, and is served on the hub's origin only when the slot is left
out (or there is no pool); the hub's own pages and the assets are never
sent anywhere, and a slot whose agent is gone marks the navigation it
sends back (`<scope>~home/...`, answered with a 307 to the route without
the mark), so the hub's worker keeps it rather than send it back to the
slot before the hub heard, and the hub leaves that slot out. Before, a
route on the hub's origin showed its site on the hub's origin even with
its slot up: same-origin with the host page, away from its slot's
storage. The
site-pool-fallback suite shows each case (the page of 127.0.0.1 with a
frame of localhost, at their real URLs, from the host's origin, with no
page error) and prints what the first navigation took; Chrome 152, four
runs before and four after, the machine's load at 43 to 65, single origin
0.11 to 0.26 s:

| the slot                                                          | how it is told                      | first navigation, before | after          |
| ----------------------------------------------------------------- | ----------------------------------- | ------------------------ | -------------- |
| no origins, `sitePool: false`                                     | no hub                              | 0.10 to 0.19 s           | (the same)     |
| port closed                                                       | the probe fails                     | 0.09 to 0.13 s           | 0.06 to 0.32 s |
| port that takes the connection and never answers                  | the probe times out                 | 5.1 s                    | 0.95 to 1.08 s |
| a front's own page on the port (an error page, a login)           | no hello after its load             | 3.1 to 3.2 s             | 1.1 to 1.3 s   |
| the service worker's script 404 or of a wrong MIME type           | the registration throws             | 0.17 to 0.37 s           | 0.11 to 0.36 s |
| a worker that registers and is not STomp's                        | no hello from the worker            | 30.1 s                   | 1.2 to 1.3 s   |
| not a secure context (a LAN name over http:, a flag for the host) | the probe or the registration fails | (not measured)           | 0.24 to 0.43 s |
| kept for a site, and not answering                                | the probe fails                     | (not measured)           | 0.10 to 0.19 s |

How it is told, in order:

- **The probe.** Every slot is asked for the agent's frame file
  (`no-cors`, `no-store`) when the hub starts, all at once, and so is the
  host's own origin: a slot gets four times what the host's took, 1 s at
  least and 5 s at the most (a new connection to another port costs a
  round trip or two more than the host's warm one). The first navigation
  waits only for the slot it needs, and usually not at all.
- **The hello.** The agent's script posts it before its frame's load event,
  and the two reach the hub in that order: a frame that loaded and said
  nothing within 1 s is not an agent.
- **The worker's hello.** A STomp worker answers the agent's first
  handshake before it builds anything; one that does not within 1 s (3 s
  when the registration was there before, and the worker may have to
  start) is not STomp's.
- **Ready.** An agent whose controller is not up within 15 s.
- **Gone.** An agent whose document went away after it started (its
  renderer crashed, which takes its slot's documents with it, or the host's
  page removed or navigated its frame): its slot's worker sends a
  navigation at the agent's address to the same route on the hub's origin
  (a 307; a worker that restarted without it reads the hub's origin from
  the address's row in its database), and the hub leaves the slot out once
  a navigation it sent there reports from its own origin. A navigation from
  another slot's document to a site of it waits for the agent's answer for
  4 s (the agent shares its slot's process, so a page's long task holds it
  up too), then goes to the host's origin with what the first worker knew
  of it (referrer, policy, hint); a step of the hub's history does the
  same. The suite measures 1.1 to 2.0 s for `frame.go()` to a site of the
  stopped slot, then 0.2 to 0.3 s for a link from another slot (4.4 s when
  the link is the first to find the agent gone); before, `frame.go()`
  showed Chrome's error page. Every call the hub waits on an agent for
  has that 4 s bound, the viewport and geometry a `frame.go()` tells the
  slot first included: when nothing else had asked the agent since its
  document went, a `frame.go()` to a site of the slot waited for good on
  them, and now shows the site from the host's origin in about 4.1 s.

A page that is not a secure context has no service worker, so no STomp
at all: the reachable case is a secure host whose slots are not (another
scheme, or a name only the host was let through as).

Limits: a step within the run of a slot whose agent is gone is not taken
(that origin's history is the agent's to step; `frame.back()` steps to the
run before it instead), and a link from another slot's document to a site
of a slot whose agent is gone waits the 4 s once per page.

## Isolation mode (RemoteController)

`RemoteController` takes the same `sitePool: { origins }`: the slots are
other ports of the proxy origin's host. The hub is the controller inside
the controller frame (src/controller/frame.ts, on the proxy origin), its
agents are that frame's own frames on the slots' origins, and the proxied
frames stay the host page's, which `RemoteFrame.go()` navigates straight to
the slot of the URL's site (the controller frame answers `siteOrigin`).

Measured first with a fixture of no STomp (a page of localhost embedding a
frame of 127.0.0.1:P, which embeds frames of 127.0.0.1:B and :C that
register a service worker each; Chrome 152): a frame the host page adds on
127.0.0.1:B is controlled by the worker its nested agent registered (both
are third-party contexts under the same top-level site, so one storage
partition), and with `Origin-Agent-Cluster: ?1` on B and C the host's
frames on B and C are processes apart (a frame's timers 12 ms late while
the other spins 300 ms, against 302 ms for two frames on P and 305 ms
between B and C without the header; six renderer processes against four).

What the controller frame did by reaching into its same-origin siblings
it asks the agents for when the frame shows a slot's document: the host
addresses a frame by its index in its `frames` and the slot its document
last reported from (`frameInfo`, `frameCommand`, `frameActivated`), and
that slot's agent reads the host's frame (`parent.parent[index]`, of its
own origin) for its URL, title and history, steps it, reloads it and
notes its user activations. The host takes reports from the slots'
origins as from the proxy origin's (from its own frames only), and
`RemoteFrame` keeps its history as runs, as `Frame` does (Back and
Forward, above; src/controller/siteRuns.ts, isolated halves below). A
slot's documents may be
framed by the host, the proxy origin and every slot (`frame-ancestors`:
a frame of another site in a page is a frame of another slot); their `top`
stops below the host page (`sites.hub` is the host's origin, not the
controller frame's); in a cross-origin isolated host page the frames
delegate the permission to every slot; and a page that waits on the sync
bridge also tells the frames of a frame of another origin, where the
agents are (they are not the page's siblings here).

The site-pool-isolation suite compares the three on one fixture (a page of
127.0.0.1 with a frame of localhost), fourteen runs in Chrome 152, 156 and
157 at a machine load of 40 to 70: the frame's timers while its parent
spins 300 ms were 6 to 12 ms late natively, 5 to 11 ms with the pool and
300 to 301 ms without it, and the page and its frame are out-of-process
frames of two slots. The first frame of the pool took 0.54 to 1.17 s to
show (the agents start and the slots' workers install), against 0.25 to
0.49 s without it.

**The demo's isolated page uses it by default too** (`?nopool` leaves it
out), as the same-origin page does; the isolated halves of the suites run
with it. Under the isolated host (COOP `same-origin` with COEP) a proxied
page's popups are null (Popups under the isolated host, above), so a
browser of no `Document-Isolation-Policy` is the case for `?nopool`.
What that took is under "Isolation mode's halves of the suites" below.

A slot left out falls back to the controller frame's origin there, as the
pool's fallbacks do in the same-origin mode (above): a slot's worker sends
the navigations of an agent that is gone to the hub's controller's origin
(`sites.home`, the proxy origin here), never to the host page's.

## Isolation mode's halves of the suites

With the pool on in isolation mode by default, five suites' isolated
halves failed where the same suites passed with it off (Chrome 157). Each
was a path of `RemoteController` that the same-origin `Frame` had and the
host-page side lacked:

- **Critical-CH** (client-hints): the slot's worker makes a frame's
  navigation and its Critical-CH retry, and only the hub's worker was
  told the frame's size, so the retry carried no `sec-ch-viewport-width`
  (natively it does). `RemoteFrame.go()` now tells the slot's worker
  before the frame goes there (`viewport` with the slot's origin, as
  `Frame.go()` does with `siteViewport`).
- **A link into a named popup** (navigation-initiator): the host opens
  it as a tab of its own (`onOpen`), and `RemoteFrame.go()` sent that tab
  straight to the slot of the URL's site, whose worker never heard the
  page's NAVIGATION_HINT and took it for the user's own (Sec-Fetch-Site
  `none`, natively `cross-site`). An open request from a slot is kept by
  its URL for 10 s, and the tab's first navigation leaves from that slot,
  whose worker hands the hint on with its 307 to the URL's slot, as for
  the page's own links. Forms into a named popup never reach the host
  (the browser opens the window from the page's slot) and passed before.
- **A site's device ids forgotten with its cookies** (permissions): the
  controller frame runs the host's `cookies` commands through
  `cookieCommand`, which skipped what the `cookies` wrapper does for the
  pool (the slots' workers forget the site's device-id salts, the slots'
  documents hear the jar changed), so the first site kept 5 of 5 ids
  (natively none). `cookieCommand` does both now.
- **Back and Forward across slots** (toolbar-history, 4 sequences):
  `RemoteFrame` kept a trail of slots with one history per slot, stepped
  to another slot with `location.replace`, and knew neither how a
  document was navigated to nor its frames' moves in other slots, so
  Back stayed on after returning to the first site and a page that
  replaced itself with another site's kept its old entry. It keeps runs
  now, as `Frame` does (src/controller/siteRuns.ts): the agent of each
  run's slot keeps that run's states through the controller frame's
  `frameHistory` call, a step to another run is the browser's own
  traversal from the frame's document (unless another tab changed the
  joint session history since), the report carries the navigation's
  type, and the agent of the frame's slot hears of the history moves of
  the page's frames that show another slot's documents. `Frame` keeps its
  own copy of the same logic for now.
- **`history.length`** (visited, the documents a link led to, both
  modes): the History module answered it with `navigation.entries()`,
  which Chrome lists a document only for its own origin's stretch, so a
  link from A to a site of another slot changed the length by -5 where
  natively it grows by 1. Each top document reports where it is in its
  slot's stretch beside its navigate report (`HISTORY_RUN`: index and
  length), the hub counts every run (`Frame`, and `SiteRuns` for
  `RemoteFrame`; a run left for a new one keeps its entries up to its
  document, one fewer after a replace) and tells the agent of the
  document's slot how many the other runs hold (the runs' `sync`), which
  sets it on the document's client (`historyAcross`); `history.length`
  adds it. The count reaches a document with the hub's answer to its
  first report, after its first script; for that script the hub tells
  every agent, after each report, where the frame is in its runs (the
  entries before and after its run, its place and count in it:
  `RunsExpectation`, src/controller/history.ts; an agent started later
  is told once it is ready, before its slot shows anything), the agent
  keeps on its window (SITE_RUNS) the length of the frame's history for
  its next document of the agent's origin, after a push and after a
  replace or reload, and the document's Navigate module counts the rest
  as it starts.
  A traversal is not told: its document reads its own slot's stretch
  until the hub's count arrives. top-navigation measures both (the
  history.length a landed document reads at its first script and half a
  second in).

The visited suite also applied its pool expectations to the same-origin
half alone: with the pool a frame of B under A is another slot's, so its
navigation is recorded as natively (no fresh context), and the self-link
rows read as natively in S's slot, in isolation mode as in the
same-origin one (Self-links of another slot, under Open).

A link whose target names a popup window the page opened (not a frame)
goes to the host as an open request and opens a host tab instead of
navigating that window, with or without the pool; its request headers now
match native.

## Threat model

The security model is the emulated same-origin policy, with a pool as
without one: what one site's document may do to another's is the inject's
and the worker's to decide, and the pool must hand out nothing that single
origin does not. The site-pool-sop suite holds it to that: the paths of
window-references and more, natively, with the single-origin controller,
with the run's pool and with a pool of one slot (every site shares it), and
every answer of a pool is native's or single origin's.

What the slot boundary adds, between two sites in two slots, as defence in
depth:

- The other site's window is the browser's cross-origin WindowProxy, so
  the paths single origin still leaves open (window-references' known
  open: a popup held from about:blank, native copies of `frames`, a named
  frame on `document`) are restricted by the browser itself.
- Each slot is a process and a heap of its own (`Origin-Agent-Cluster`),
  so a renderer bug or a speculative read in one site's process does not
  reach the other's memory.
- The hub's page is of another origin than every proxied document: a page
  that got the real `top` past every hook holds a window it can only post
  to, where with single origin it is the host's page itself.

What it does not add:

- **Sites that share a slot** are one origin to the browser and are kept
  apart by the emulation alone, exactly as every site is without a pool.
  So every hook must answer as it does without a pool, and no hook may
  hand out a window raw because "the browser restricts it": what the
  browser restricts now it does not once the frame shows a site of the
  page's own slot. All three were holes, fixed: a frame's `contentWindow` read
  while its document of another site was on the way was raw on the guess
  that the site would be shown from another slot (in a shared slot the
  page read, called and wrote that site's document), and a frame's window
  of another slot was raw on every path (`frames[i]`, `contentWindow`,
  `opener`, `event.source`), so with a pool of two slots a page that held
  it read the document of a third site the frame went to next, which the
  pool showed from the page's slot. And the frame of a frame of another
  slot, shown from the page's slot (a first visit with two slots, or more
  sites than slots), got its parent raw, and the browser's `parent` of
  that window (the rewriter routes no `parent` read off a window) is the
  page's own window, of the inner frame's origin: it read
  `parent.parent.document` (site-pool-revisit). Every path now answers the stand-in,
  as with single origin (one per window for every document of an origin
  in a frame tree, so `t = t.parent` still meets `top`), and a window the
  page already holds as itself (a popup it opened on about:blank) comes
  back as itself, as with single origin. The stand-in's `parent` is the
  stand-in of a parent of another slot too, never itself (only the hub's
  page is the proxied world's edge): a climb by `parent` from a frame in
  the slot of the frame it is in (a revisit keeps a site's slot) stopped
  there and never met `top`, and Yahoo's ad and consent loops spun their
  renderer and the slot's agent for minutes.
- **Storage and cookies** live on the hub's origin and in the slots'
  workers, not in the browser's per-origin stores: the cookie jar is the
  host origin's one database, and every slot's worker asks it over a port
  the hub's transport worker answers, for any site. Which cookies and
  which stored values a document gets is the worker's keying by site and
  partition, as without a pool. The jar's and the blocker's ports are held
  by the slot's worker and its agent, never handed to a document; the hub's
  worker takes a blocker port only from the tab that registered it.
- **Ports are one site** to the browser: cookies of the host ignore the
  port (the sync bridge's answers among them), and so does everything the
  browser keys by site (its HTTP cache and network partitions, `SameSite`,
  `Sec-Fetch-Site` between slots and the host). Its permission grants are
  per origin, so per slot, and a slot's sites share them.
- **The agent** of a slot (`controllerFrame.html?script=siteFrame.js`) is
  same-origin with the slot's documents and holds the hub's RPC port (the
  transport, the jar, the blocker, slot answers), the codec key and the
  hub's token. It has no name and is a frame of the hub's page only, so a
  document reaches it only through the hub's window, which every hook
  hides (the browser's own `top` getter too: site-pool-sop). The same
  escape with single origin is the host's page, same-origin, which holds
  all of that and more. The agent also holds the rewriter library every
  frame of its slot with no top in reach rewrites in, whatever its site
  (sites that share a slot share it, as the frames of every site under one
  top share the top's), and code that could change that library's realm
  would change how the others are rewritten. Its realm is a removed
  about:blank frame of the agent's document, made before any document of
  the slot existed: it is in no frame tree, so no walk of windows meets
  it, and it is held only by the agent's share and by the inject of the
  documents that rewrite in it, whose client sits on each window under the
  name the controller mints (src/helperNames.ts), which no page is told and
  no key of a window shows. And a page's own realm never hands the library
  an object: only strings, numbers and booleans cross, as arguments and as
  results (src/inject/rewriter.ts), so a page that replaces its own
  builtins changes what its own realm does and nothing the library's
  realm runs. site-pool-agent holds this with two sites in one slot: no
  document reaches the agent, its share or the library's realm by `top`,
  `parent`, `opener`, `frames`, `event.source`, `window.open('', target)`
  or a popup on about:blank through its own globals, even knowing the
  share's name, and a frame that pollutes Array, Object, String, RegExp and
  JSON in its realm leaves another site's eval, new Function and indirect
  eval in the slot answering as natively.
- **The hub's token** (Config.sites) is in every slot document's shell
  beside the codec key, and in no part of the page's view of its markup
  and scripts (site-pool-sop). A receiver takes a message of another slot
  only in an envelope with it, and a navigation request only with it and
  from a frame the browser says is under it (`event.source`); a form's
  copy gets only the method, enctype and accept-charset the sender sends.
  A page that read the token could forge an envelope from any origin to a
  window of another slot: with single origin the same escape (the inject's
  own objects) gives as much.
- **A message another slot's page posts past its inject**, with the
  browser's own `postMessage` of a window of another origin
  (`w.postMessage` read into a variable and called, a descriptor's value),
  names no site: it arrived from the slot's origin, and now never arrives.
  With single origin it arrives from the sender's origin, as natively.
- **A frame's route marker** names its top origin and partition, which a
  frame whose parent is of another slot reads (`slotMark`). The worker read
  every nested document's partition from that marker before the pool
  (`kindPartition`), so a document that chose its own route (it would need
  the codec key and a navigation past the inject) gets no partition it
  could not get with single origin.
- **A navigation's arrival** (the 307 to another slot) is handed to the
  target slot's worker by the hub, keyed by the routed path, for 10 s: a
  navigation to the same route in that time takes it. What it carries is
  what the departing worker would have sent for a navigation to that very
  URL (referrer, policy, hint), so another document of that site gets
  nothing it would not, and the navigation it was for goes without it.
- No document reads a slot's origin: the suite reads `location`,
  `document.URL`, `referrer`, `baseURI`, `origin`, `domain`,
  `ancestorOrigins`, performance entries, an error's stack, a script's
  `src`, the navigation entry and the markup in a page, its frame of
  another slot and its popup, and error-surfaces reads the SecurityError
  of a cross-origin read, whose message the browser's own getter would
  write with the slot origins (the stand-in's names the sites'). Not covered there: CSP reports, and the
  Referer and Origin a real site sees (the site-pool suite compares a link
  and a form POST with Chrome's).

## A reload of the host's tab

The host's controller tells its worker how the host page was loaded
(src/controller/hostReload.ts), and the page the host shows again right
after takes the reload's cache mode. With the pool that page is a slot's,
and the slot's worker had not been told: a reload or a hard reload of the
tab restored the page from the caches where Chrome confirms the document
or fetches it and everything it loads again (http-cache). The hub hands the
mode to every agent that starts within ten seconds of learning it (the
worker's own window for a restored page), and the agent tells its worker
as the hub told its own; an agent that starts later is told the host was
not reloaded, never left to guess from its own frame.

## Two tabs of the host

A slot's worker serves every tab of the host open at once: each tab has an
agent of its own in the slot, and each agent shook hands with the worker
over ports of its own tab, the cookie jar's among them. The worker asked
the jar over the newest handshake's port only (a reload of the tab leaves
the older port dead). When the newer of two tabs closed, its port went
dead with no event (Chrome fires no `close` on a port whose tab goes, and
the agents' `pagehide` close message did not come either), and the older
tab's next document of that slot waited for good on its first cookie read:
its frame stayed `about:blank` and never reported, so `frame.url` named
the page before it (the demo-bookmarks failure: the bookmark star saw no
page, and the demo's fragment, written once a navigation reports, brought
the previous page back on a reload). The worker now keeps every
handshake's port (src/server/jarDB.ts `RemoteJar`), asks the newest, and
when a request goes unanswered `JAR_CHECK_MS` (500 ms) and the agent of
the port it asked is no longer a client of the worker, asks the newest port
whose agent is, every request without an answer again (each is safe to
repeat). A tab in the back/forward cache is not a client either: its port
is kept, and stays the one asked when no other tab is open. The first
document after the close waits that half second once (site-pool-tabs
suite; natively the frame's next page loaded in 8 to 11 ms).

## A returning visit's scripts in a slot

The rewrite cache's key holds the config a script's rewrite depends on,
and the config of a slot's worker holds the hub's message token
(`sites.token`), which every hub page mints anew. So every script of a
site shown from a slot missed the cache on every visit in a new tab, and
was given as a new Response (`fallback-code`) instead of the store's own,
with no compiled code kept for it (controller-ids; with the pool off the
same visit is `cache-storage`, `stomp-rewrite-cache`). A page script's
output never carries the token, so its key leaves it out, as it leaves out
the client's name; a worker's preamble carries the whole config, and its
key keeps it.

## Slot workers kept running

A slot's agent has no clock of its own: the hub's controller ticks every
agent with its own keep-alive (SiteHub.tick, every 20 s on a worker's
clock), spares included, so the worker of every slot this page started
stays up as the hub's does. sw-keepalive checks it in Chrome 157: the
shown document's slot worker runs for 45 s of an idle page, and without
the tick it and the spare's stop at 30 s. The spare the hub starts while
the page sits (SiteHub.warm, about 1 s after the shown slot's agent is up)
is a new worker version, which the DevTools protocol first reports as
stopped and then starting: that is a worker starting, not one stopped.

## The proxy's own origin from a slot, in isolation mode

In isolation mode the hub is the controller frame, so `sites.hub` (the
host page's origin, the real top) and the proxy origin (`sites.home`, the
controller frame's) are two origins, and `proxyOrigins` named only the
first. A slot's worker and its documents then read a URL of the proxy
origin as a site's: `fetch(<proxy origin>/stomp/serviceWorker.js)` from a
slot's document went out over the transport, which does not reach the
proxy's own host, and the page saw `TypeError: Failed to fetch` where the
pool off answered the 403 refusal; a frame sent to `<proxy origin>/` showed
nothing. `proxyOrigins` names `sites.home` too now, so a route of it is
unwrapped on the slot as on the hub. The demo's isolated page has used the
pool by default since 4ab3d5df, which is when fetch-credentials started
to fail. Proxy-ception was then an option (`allowSelfProxy`) the slots'
agents were never handed, so the demo loaded through itself showed "Page
unavailable" from the slot that took the site. It is no option now: a URL
of the proxy origin that is no route is a site like another on every
thread (docs/proxyception.md), and the proxyception suite loads the demo
through itself with the pool on.

## An agent's frame that never commits

A tab of the host opened a second or so after another tab closed, the
closed one having had agents on some slots: Chrome sometimes never commits
the new tab's agent frame on such a slot. The frame's response arrives
(200, not from a worker) and the DevTools protocol shows the frame's target
made, but it never gets a URL, never crashes, runs no script and fires no
load event, so the hub heard no hello and left the slot out after 15 s
(Ready, in "Fallbacks"), and the tab's first site was shown from the host's
origin. That is what controller-ids' returning visit saw: its "after" URLs
on the host's origin, the rewrite cache's entry for them in the slot's
Cache Storage out of reach. It is no fault of a slot a site is homed to,
and with the pool off the visit is on the host's origin both times. Five
copies of an instrumented controller-ids at once (Chrome 157, machine load
13 to 18) stalled in 2 or 3 of every 5 to 7 returning visits; turning off
`SubframeShutdownDelay` or raising `--renderer-process-limit` did not
change it. The same navigation made again 2 s in still stalled, made again
4 s in it committed within 30 ms, so the hub now navigates an agent frame
that has not said hello again at 2, 4, 7 and 11 s (AGENT_RETRY_MS; the
gaps grow so a frame that is only slow on a busy machine still gets
through). After: 21 of 21 returning visits on the slot, at 1.8 s, or 5.6 s for the
ones that stalled (7.7 s with retries at 2, 6 and 12 s; 17 s and the
host's origin before). Not
reproduced natively: Chrome's own frames have nothing that waits on a
hello, and no native fixture of it was made.

## Open

Measured with the pool on (`STOMP_SITE_POOL=5 npm test -- <suite>`); every
suite named passes with it off (`STOMP_SITE_POOL=0`).

- **Sites that share a slot** are as coupled as without a pool, for good:
  a site cannot move without its data. Six ports are five slots, and an ad
  page has more sites than that.
- **A slot taken out of the list** keeps what its sites stored: they are
  given another slot and find none of it there, where natively nothing
  takes a site's storage away (the site-pool suite's list without a site's
  slot). They stay on the new slot when the old one is listed again: what
  they stored since is there. Every other change of the list (another
  order, a slot added) keeps every site where it was.
- **The initiator of a navigation a frame aims at another slot's window**:
  the frame's inject asks that window's to navigate itself (an envelope
  with the hub's token, taken only from a frame under the receiver), so
  the request is the receiver's own: Referer, Origin and Sec-Fetch-Site
  are the top's, where natively they are the frame's. A link and a form
  are the same with the single-origin controller; a `window.open()` aimed
  at `_top` there has the frame's, as natively. Nor is the user activation
  the browser asks of a frame that navigates the top of another site
  checked (it is not without a pool either).
- **Notifications from a proxied top** (permissions suite, 4 checks
  that expect it): the proxied top is a frame of another origin than the
  host's page, and Chrome shows no such frame the notification prompt
  (its `allow` cannot change that): `Notification.requestPermission()`
  leaves the site undecided (`default`), where natively the top-level
  site is asked (`denied` in a headless run). Before Chrome 156 such a
  frame cannot choose an AudioContext's output either (`setSinkId`
  refuses with NotAllowedError, natively it takes the id). Both are
  isolation mode's limits already. The browser's own grants are not per
  slot: a frame's permission is its top-level origin's, the host's page,
  with the pool as without it. A worker is the exception: the browser
  keys a service worker's permission by its own origin, a slot's, so the
  worker of a site granted notifications reads `granted` and cannot show
  one (permission-gates, 1 check with the pool on in the same-origin
  page; the isolated page passes).
- **Popups under a cross-origin isolated host** (COOP `same-origin` with
  COEP, production's headers; sop-escapes and popup-openers list them as
  known): a proxied page's `window.open()` is null and its popups have no
  opener (Popups under the isolated host, above). The fix is the host's
  headers, `Document-Isolation-Policy` in place of COOP `same-origin`; it
  is a patch of its own, not on by default, and needs Chrome 137 or later.
- **The sync bridge's cookies**: its answers ride in cookies of the host,
  which ignore the port, so two slots that wait at once share one budget
  (about 180 cookies a host). Pages of two slots can now wait at once.

- **The host page's own `document.hasFocus()`** reads false after a frame's
  first document commits in a slot's process (the frame was the host's
  about:blank, in the host's process), while the frame has focus and the
  page reads true; the host's `document.activeElement` is the frame. A
  host that blurs and focuses the frame again fixes its own answer, at
  the price of a blur and a focus event in the page.
- **`performance.measureUserAgentSpecificMemory()`** with the
  single-origin controller and the demo's isolation headers lists the
  proxy's own `/stomp/` URLs (the rewrite and transport workers, routed
  frames) among its attributions, where natively a frame of another site
  is `cross-origin-aggregated`; older than the pool, not fixed here.

- **Self-links of another slot** (visited, 3 rows). Chrome keys a visit
  by the frame origin of the document that started the navigation, and
  records one made on a top-level site's own origin a second time for the
  visited URL's own site and origin (self-links,
  docs/same-origin-policy.md). A link route lives on the slot of the
  documents whose links name it (a site's redirect that a link route began
  goes on through the link route on that slot's origin, whose worker sends
  the browser straight back), but the second record would have to be
  keyed by the visited site's slot, and the browser keys it by the slot of
  the page clicked on. So a link on `http://v.test` to a page of
  c.localhost reads visited on v.test as natively and unvisited on
  c.localhost's own pages when that site is shown from another slot
  (natively visited there); the worker makes no self-link route then.
  Sites that share a slot keep it. Both modes, isolation mode included.

## Hidden frames

Chrome holds the animation frame callbacks of a `display:none` frame that
is cross-origin to the browser's main frame. A proxied page under the pool
is a slot's origin in the hub's page, so natively it would be the main
frame and its own hidden frames would run; framed by another origin they
do not. Measured natively (hidden-frames.html in a frame of another origin,
Chrome 152 and 156): the page's own hidden frame is held whether the top is
another port of the same host, the same with `Origin-Agent-Cluster: ?1` on
the page, or another site; with a top of the page's own origin, or as the
top itself, it runs and measures 0. The inject runs such a frame's
callbacks from the proxied top's animation frames while it has no box
(src/inject/dom/modules/AnimationFrames.ts), which isolated mode needed as
well; the hidden-frames suite compares every frame in both modes.

## Inline documents

A document a page makes itself (a javascript: URL's string, a text/html
blob, a data: frame) is registered with the worker of the page's own
origin under a single-use token and served at `inline:<token>/<referrer>`
on that origin (src/server/inline.ts). Under the pool each origin's worker
has its own tokens: the one that took the registration is the only one
that can serve the document, and any other (another slot's, the hub's)
answers its route with the error page. So an inline route never leaves for
another slot (`leaveSlot` in src/server/serviceWorker.ts): its URL names
the referrer, whose site the pool may show elsewhere (a page of the hub's
origin while its slot is left out, a referrer of another site), and before
the hub sent routes to their sites' slots such a route went there and
showed the error page in place of the document. An unknown, used or
expired token gets the error page from the worker of the origin the route
names. A slot the pool has not brought up yet has no worker, and the
host's server answers its routes with its own 404
(inline-documents suite).

## Other suites' lists with the pool

The pool shows the same-origin page's sites from slots, origins other than
the host's, so some of what other suites list as known for that page holds
only with the pool off (the suite reads `SLOT_PORTS`, test/lib.mjs):

- **window-children**: an array method the page made a method of the
  window and calls as one reads a frame of another site's document with
  the pool off (listed); with it on, the frame is of another slot's origin
  and the browser refuses the read itself (SecurityError, as natively).
  The suite checks that the frames are of an origin not the page's.
- **performance-entries**: a long animation frame's rendering part and a
  layout shift's last input time, which Chrome keeps per local root, read
  as natively: the slot's page is a local root of its own, as in isolated
  mode.
- **surface-enumeration**: WebGL's `powerPreference` reads `low-power` in
  the document and its frame where natively it is `default`: Chrome gives
  a frame of another origin than its top the low-power GPU, which a slot's
  frame is (isolated mode lists the same, docs/browserleaks-baseline.md).
  Open: what the browser chose is what the page renders with.
- **performance-clocks**: a frame of another site reading the page's
  allocations in its own `performance.memory` (one renderer heap) is
  listed as maybe with the pool on: Chrome gives a slot's frame a process
  of its own when it gives an `Origin-Agent-Cluster` origin one, and not
  always, so the figure reads as natively in some runs (Chrome 157: 2 of
  3 in the same-origin page, 1 of 3 in the isolated one) and not in
  others (test/perf.mjs `report`, a listed entry's `maybe`).
