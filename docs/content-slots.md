# Content slots for dialing

**Off by default (2026-11-20). Dialing itself (just call stomp) is the
demo's default since 2026-11-20 (demo/README.md, "Dialing"); the slots are
its UI/content split. docs/content-slots-deploy.md is what production needs,
prepared and not applied.**

Dialing writes every proxied document into a fresh frame of one constant
call page the service worker serves (src/controller/justCallStomp.ts,
src/server/called.ts). Without slots that call page is on the host page's
own origin: powerMouse's UI and every page it shows are one origin, one
agent cluster and one renderer process, so a busy page holds up the UI's
input and frames, and a page that got past the inject's hooks is
same-origin with the UI.

A content slot is another port of the same host (`https://host:2053`),
served by the same server, whose every response carries
`Origin-Agent-Cluster: ?1`. The call page and every document written into
it are the slot's: another origin than the UI's, another agent cluster
and another process. The UI and the pages reach each other only by
messages (the call page's port and the hub's envelopes); no window of
the other side can be scripted or read.

## Turning it on

- **The library.** `sitePool: { origins: [...], warm: false }` on the
  controller, and `justCallStomp(frame, url)` for the frames. The slots are
  the site pool's (docs/site-pool.md): its agents, its worker per slot, its
  assignment and its fallbacks. `warm: false` keeps a slot that no site
  uses from costing anything (below, Lazy slots).
- **The demo.** `STOMP_SLOT_PORTS` (a list, `2053,2083,2087,2096`, or a
  number of free ports; unset, `0` or `off`: none) makes the server answer
  on those ports as on its own, with `Origin-Agent-Cluster: ?1`. Behind a
  front, `STOMP_SLOT_PORTS_PUBLIC` lists the ports as the browser reaches
  them; the server binds nothing for them and takes the front's
  `X-Forwarded-Port` for them (and only for them) as the port asked. The
  page gets the ports as `STOMP_CONFIG.contentSlots`, and only a page that
  dials uses them; the classic tabs (navigated) never do, and have their
  own pool (`STOMP_SITE_POOL`). `?nopool` leaves the slots out for one
  visit. The test harness picks free ports for `STOMP_SLOT_PORTS` as it
  does for `STOMP_SITE_POOL` (test/run.mjs, `CONTENT_SLOT_PORTS` in the
  suite's environment).

## Which site gets which slot

The unit is the **site** (the registrable domain, as the membrane, the
cookie jar and Chrome's process model key it), not the tab. The rule is
the site pool's (`SiteSlots`, docs/site-pool.md "Design"):

- a site keeps the slot it was first given, for good, in every tab and
  visit of the host (the host origin's IndexedDB `kept-site-slots`): what
  a page stores in the browser's own stores is the slot origin's, so a site
  that moved would find nothing of it;
- a site seen for the first time gets an empty slot, else the slot used
  longest ago in this page, and never the slot of the document its
  navigation comes from when there is another, so a frame of a new site is
  always in another process than its embedder;
- a frame of the page's own site stays on its parent's slot (same-site
  documents of one browsing context group reach each other synchronously,
  so they must be one origin); a frame of another site goes to its own.

Per tab would be wrong: two tabs of one site would be two origins (its
storage split, its windows unable to reach each other), and a site would
change slot with the tab it is opened in.

How many: measured in Chrome 157 (docs/site-pool.md "Just call stomp on
the slots", two runs each, twelve tabs of twelve sites):

| slots | each site's first page, median | MB, 12 sites | renderers | UI key input p95, busy tab |
| ----- | ------------------------------ | ------------ | --------- | -------------------------- |
| none  | 190-219 ms                     | 461-473      | 3         | 145-148 ms                 |
| 1     | 189-242 ms                     | 544-561      | 4         | 2-4 ms                     |
| 5     | 194-212 ms                     | 816-826      | 8         | 2-9 ms                     |
| 10    | 311-482 ms                     | 1140-1164    | 13        | 3-4 ms                     |

One slot already takes the pages off the UI's thread (the jcs-slots suite
measures it again on every run: key input 1 to 2 ms p95 from a slot
against 148 to 149 ms in one origin, animation frames 17 against 183 ms);
more slots give sites processes of their own, at about 65 to 70 MB a slot
in use; ten or more slow every new site's first page (each is the first of
its slot) and Chrome stops giving processes at about 16 renderers. Behind
Cloudflare at most four extra ports can be had (docs/content-slots-deploy.md),
under that cap of about five, so production uses all four. With more sites
than slots, sites share a slot, as every site does without one; the
emulated same-origin policy keeps them apart, exactly as without slots.

## Lazy slots

A slot's agent (the hub's hidden frame on the slot's origin, which
registers that origin's service worker and runs its controller) is made
the first time a site is shown from the slot. With `warm: false` the hub
starts no spare agent while its page is idle (docs/site-pool.md
"Spares"), so a slot no site uses has no worker, no process and no
storage. What the hub does at start for every slot is one `no-cors`
request for the agent's frame file, to learn whether the slot answers
(Fallbacks); it registers nothing. The jcs-slots suite counts the
profile's registrations: none on any slot before a site is shown, then
exactly the two slots its two sites use, of four.

The price is the slot's start (0.2 to 0.5 s: its frame loads, its worker
installs and shakes hands), which a site's first page from a slot not yet
used waits for.

## Fallbacks

The UI's own origin takes a document, as dialing without slots does,
wherever a slot cannot:

- no slots configured: SystemYA's framed `/ui/`, the single-file offline
  page, a host or front without the ports, `?nopool`;
- a slot that does not answer from here (a network that lets the host's
  port through alone, a front's error page on the port, a worker that is
  not STomp's): the hub leaves it out for the page (docs/site-pool.md
  "Fallbacks"), and its sites are written on the UI's origin;
- a slot whose agent went (its renderer crashed, the host removed it): the
  hub finds out when it tells the agent the frame's viewport, or asks it to
  have its worker hold the call's token, before a call (4 s at most each),
  leaves the slot out and calls from the UI's origin; a move a slot's
  worker sends to the hub's origin (`x-stomp-call-moved`, with the `~home`
  mark or without) is called there too, with a token of the hub's worker;
- a slot whose call page does not load in 10 s, or does not say it is
  ready (`{ ready: true }` on its port, docs/dialing.md) within 10 s of
  loading (its worker went, its port answers with another page): no call
  went, so the hub leaves the slot out and calls from the UI's origin. The
  call's first answer comes after the worker's upstream fetch; the ready
  bounds the wait on a slot that died before it.

The fallback is per page and per slot, silent to the proxied page (a
console warning on the host's), and a slot left out stays out while the
page lives; the site keeps its slot for the next page. A frame of a
called document is never moved to the UI's origin: one whose site's slot
is left out stays unwritten (fail closed below the top).

## What the ports are not

- **Not a cookie boundary.** Cookies ignore the port: every slot and the
  UI send and receive the host's cookies, and the proxy's own cookie jar is
  one database for every slot (the host origin's, asked over a port).
- **Not a sandbox and not a security boundary.** A slot is a process,
  heap and storage split, for the UI's responsiveness and defence in depth
  (a page that escapes the inject lands on a slot, not on the UI's origin).
  Sites that share a slot are one origin to the browser and are kept apart
  by the emulation alone, and the browser keys by site everything it keys
  by site (HTTP cache, network partitions, `SameSite`, permission grants).
- **Not anonymity.** The front, the edge and the wisp relay see what they
  see without slots.
- **A slot that dies.** A call page that goes says so (`{ gone }`), and
  while its call is out the host pings it (`{ ping }`, `CALL_PING_MS`);
  one that answers nothing for `CALL_GONE_MS` (10 s, a slot whose process
  went, which says nothing) is taken for gone. Before it said it was ready
  no call went, and the call is made elsewhere; after, the call went (it
  may have been a POST), so it fails then and is not made again.
- **Nothing is relaxed for them.** The slots change which origin a call
  page is on, nothing of what a document may do: the call page's own
  headers are unchanged, a response's policies are applied as dialing
  applies them on one origin (its known gaps, header CSP, XFO,
  Permissions-Policy and activation, are dialing's and are not widened
  here), the frame's `allow` attribute names the slots only for features
  the host page itself has (`slotAllow`, as the site pool's navigations),
  and the host and the server add no `X-Frame-Options` or
  `frame-ancestors` that a cross-origin slot would need lifted.

## Open

- `RemoteController` (the demo's `STOMP_PROXY_ORIGIN`) does not dial yet;
  the demo keeps such a page in the navigated mode.
