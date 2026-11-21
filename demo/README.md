# STomp demo

A small host application for STomp: a landing page with an address bar and
quick links that turns into a browser view (address bar and transport switch
on top, an early-Android style navigation bar at the bottom) around a proxied
frame. The look is adapted
from [Powermouse](https://github.com/Titanium-Network/powermouse); the
behaviour is built entirely on the public `StompController` API, so it doubles
as a reference integration.

## Running it

Node 22 or newer. `demo/server.js` loads `package.json` with the
import-attributes syntax on purpose: older, unsupported Node releases fail at
parse time rather than run the proxy on an unpatched runtime.

```sh
npm install
npm run build          # produces dist/
npm run demo           # http://localhost:8080
```

With the vibeOS submodule checked out (`git submodule update --init`, then
`npm ci --prefix vendor/vibeOS --omit=dev --ignore-scripts`), the build also
makes `dist/vibeos/` and the page can switch to vibeOS's desktop, every tab a
window of it; without it the page has no vibeOS switch. See "vibeOS" below and
[`docs/vibeos.md`](../docs/vibeos.md).

Environment variables:

| Variable                  | Default        | Meaning                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `8080`         | HTTP port                                                                                                                                                                                                                                                                                                                                                                 |
| `STOMP_WISP_URL`          | unset          | External wisp endpoint for the transports; when set, `/wisp/` is not served and no holyWisp is started                                                                                                                                                                                                                                                                    |
| `STOMP_PROXY_ORIGIN`      | unset          | Origin serving the proxy for isolation mode; empty means same origin                                                                                                                                                                                                                                                                                                      |
| `STOMP_ISOLATION`         | on             | `off` leaves out the headers that make the pages cross-origin isolated (see Cross-origin isolation)                                                                                                                                                                                                                                                                       |
| `WISP_ALLOW_LOOPBACK`     | unset          | Set to `1` to let the built-in wisp reach `127.0.0.1` / private networks (local QA)                                                                                                                                                                                                                                                                                       |
| `WISP_NO_UDP`             | unset          | Set to `1` to make the built-in wisp refuse UDP streams (HTTP/3 fallback QA)                                                                                                                                                                                                                                                                                              |
| `WISP_BLOCK_HOSTS`        | unset          | Hostnames the built-in wisp refuses, comma separated (a test run names the content blocker's list servers)                                                                                                                                                                                                                                                                |
| `HOLYWISP_BIN`            | unset          | Path of a `holywisp` executable to run instead of the one the `holywisp` package ships for this platform                                                                                                                                                                                                                                                                  |
| `HOLYWISP_LOG_LEVEL`      | `error`        | Log level of the built-in holyWisp (`debug` shows every stream and why it closed), printed on stdout                                                                                                                                                                                                                                                                      |
| `STOMP_HTTP3`             | on             | Set to `0` to turn off HTTP/3 for the epoxy transport (`?http3=0` turns it off for one visit, `?http3` on); docs/http3.md has what it costs and why it is on                                                                                                                                                                                                              |
| `STOMP_WISP_WEBTRANSPORT` | on             | Set to `0` to keep Wisp on the WebSocket; else epoxy tries the relay's WebTransport session first (docs/webtransport.md, "Wisp over WebTransport"): a URL names it (a public certificate) or, ending in `.json`, its document; the built-in holyWisp's is asked when it serves one (`?wt=0` / `?wt` decides for a visit); About's Transport row says which Wisp rides now |
| `STOMP_ADBLOCK`           | on             | Set to `0` to turn off the content blocker (docs/adblock.md), a JSON object is its `adblock` option; `?noadblock` and `?adblock` do one visit, the toggle is kept                                                                                                                                                                                                         |
| `STOMP_ECH_DNS`           | Cloudflare DoH | DNS-over-HTTPS endpoint epoxy asks for HTTPS records to offer real Encrypted Client Hello (docs/fingerprint.md), and HTTP/3 asks for a name's first request (docs/http3.md); `off` sends GREASE ECH only (`?noech` does one visit)                                                                                                                                        |
| `STOMP_SITE_POOL`         | `0`            | More ports to answer on, a list or a number of free ones to take: the slots of the site pool (see Site pool; `0` or `off` for none, `?nopool` on the page leaves it out for a visit)                                                                                                                                                                                      |
| `STOMP_SLOT_PORTS`        | `0`            | More ports to answer on for dialing's content slots (see Content slots), as `STOMP_SITE_POOL` takes them; only a page that dials (the default, see Dialing) uses them; `STOMP_SLOT_PORTS_PUBLIC` lists a front's                                                                                                                                                          |
| `STOMP_DIALING`           | on             | Set to `0` for the classic tabs, each frame navigated to its page's route (see Dialing): for the test suites of that path; there `?mode=just-call-stomp` dials again. No address of the page turns dialing off                                                                                                                                                            |
| `STOMP_DEFAULT_THEMES`    | Shooting Star  | Web Store ids, comma separated, of the themes a new profile has installed and not shown (docs/themes.md, The default theme); `0` for none, which the test suites use                                                                                                                                                                                                      |
| `STOMP_TEST_TRANSPORT`    | unset          | Set to `1` to use `/test/mixed-transport.mjs` (epoxy that reaches the suites' fixture hosts: mixed-content's, and the names under a private suffix); test runs only                                                                                                                                                                                                       |

They can also live in a `.env` file next to `package.json` (not committed);
the server reads it at startup. The page gets what it needs from `/config.js`.

## Tor routing

The homepage has a **Tor** checkbox beside **Block ads**. It is enabled
unless the server turns Tor mode off (`STOMP_TOR_CLIENT=0`). The choice is
kept in `localStorage['stomp-demo:tor']` (or set for one visit with `?tor` /
`?notor`), independently of the content blocker. Changing it reloads the
page, since `controller.setTransport()` allows requests already using the
old transport to finish. Tor uses a separate `/stomp-tor/` service worker
scope and a STomp profile of its own on the same origin (docs/tor.md,
"Profiles"): its own cookie jar, site storage, HTTP and rewrite caches,
permissions and extensions (none until one is installed in Tor mode), and
the page's history and tabs are not kept. The profile is wiped when Tor is
turned off and when the last Tor-mode tab closes. HTTP/3, UDP, WebTransport
and the external ECH DNS lookup are off. Where the server offers
no Tor, a saved Tor choice stops browsing rather than trying the normal Wisp
endpoint.

**Tor mode is a Tor client in the browser** (docs/tor-over-wisp.md):
`config.js` says `torClient: true` and `/api/tor` answers
`{"state":"client"}`. The transport worker runs arti (tor-js) and builds the
circuits itself; `/wisp/` carries only TCP to Tor relays (the worker refuses
a link to anything else), so the server never sees a destination. It does
see that a visitor uses Tor and which Tor guard they use; bridges, which
would hide that, are future work. The Tor chip shows the bootstrap's
progress, and the menu has **New Identity** and **New Tor circuit for this
site**. `node test/tor-client-smoke.mjs` checks it against the real Tor
network. The client is tor-js built from source with a stream API
(deploy/tor-js/README.md), pinned in package.json as
`github:Fracital/tor-js`, so Tor mode runs epoxy on Tor streams:
connections kept per site, HTTP/2 and WebSockets. The suites run with `STOMP_TOR_CLIENT=stand-in`, which answers Tor
mode with epoxy over `/wisp/` (`demo/public/test/tor-stand-in.mjs`), since
they reach no Tor network.

There is no server-side Tor relay any more: `STOMP_TOR_SOCKS5`,
`STOMP_TOR_WISP_URL`, `STOMP_TOR_CONTROL` and the other `STOMP_TOR_*`
settings of the old `/wisp-tor/` relay are ignored, with one line at
startup saying so. That relay saw every destination of every visitor.

**Scope:** Tor mode is for sites opened through STomp's transport. It does
**not** turn the browser into Tor Browser: the application shell, the
commit list and other requests the host makes directly do not pass
through Tor, and shared logins and browser fingerprints can still link
sessions. `docs/tor.md` has the privacy scope in full.

The bundled `tor.app` example is an Anura-specific Tor WASM/Snowflake client,
not a compatible STomp Wisp transport. `docs/tor-app-audit.md` records the
issues found during review; none of its compiled scripts or WASM assets were
copied into this feature.

## Developing

```sh
npm run dev            # esbuild watch + this server with live reload
```

`scripts/dev.mjs` runs `node build.js --dev` and the server under
`node --watch` (`STOMP_DEV=1`, `WISP_ALLOW_LOOPBACK=1`, `PORT` as given) in
one terminal. In this mode the server opens a WebSocket at `/__dev`, `build.js`
POSTs every finished rebuild to `/__dev/changed` (loopback only), `demo/public`
is watched, and `/config.js` carries `dev: true` plus the server's
`startedAt`. `index.html` then loads `/pm/dev.js`, which reconnects forever
(250 ms doubling to 5 s, with jitter) and applies what arrives:

| Change                                    | What the page does                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a stylesheet under `/pm/`                 | swaps the `<link>` in place, no navigation                                                                                                                                            |
| any other file in `demo/public`           | reloads the page                                                                                                                                                                      |
| `inject*.js`, `rewriterLib.js`            | reloads every proxied frame                                                                                                                                                           |
| `serviceWorker.js`                        | same origin: `registration.update()`, waits for the new worker to activate, points the controller at it and reloads the frames (identical bytes: nothing). Isolated: reloads the page |
| `Controller.js`, `controllerFrame.*`, ... | reloads the page                                                                                                                                                                      |
| the server restarted (new `startedAt`)    | reloads the page once it reconnects                                                                                                                                                   |
| an esbuild error                          | fixed overlay with the message, cleared by the next clean build of that bundle                                                                                                        |

Every step prints a `Dev` console badge ("css swapped main.css", "service
worker updated, 2 frames reloaded", "reconnected after 2.0 s").
`window.__stompDev.state` shows the connection, pending errors and the last
event. Editing `demo/server.js` restarts the server. None of this exists in
production: without `STOMP_DEV` the server serves no `/__dev`, `config.js`
has no `dev`, and `dev.js` is never fetched.

## What the server does

`demo/server.js` is an Express app plus a [wisp](https://github.com/MercuryWorkshop/wisp-protocol)
server on the same port:

| Path            | Serves                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | `demo/public` (the page, stylesheet, script, images)                                                                                    |
| `/stomp/`       | `dist/` via `stompPath` from `@sysce/stomp/path`, the classic tabs' scope ("Dialing" below)                                             |
| `/<minted>/`    | `dist/` again, the page's neutral scope, where it dials (`STOMP_DIAL_DIRECTORY`, "Dialing" below)                                       |
| `/epoxy/`       | `@mercuryworkshop/epoxy-transport`'s `dist/`                                                                                            |
| `/libcurl/`     | `@mercuryworkshop/libcurl-transport`'s `dist/`                                                                                          |
| `/wisp/`        | WebSocket upgrade handed to holyWisp (the `holywisp` package), see below                                                                |
| `/api/status`   | `{ uptime, version, node, build }` for the landing page footer and the menu's About                                                     |
| `/api/commits`  | `{ repo, url, commits, live }`, the landing page's commits: GitHub's and the git log's; `/api/commits/stream` pushes changes            |
| `/offline.html` | `build/offline.html`, built here when missing or another tree's (503 until then), and `/offline.html.sha256`; any origin may fetch them |

Nothing else is proxied by the server. All page traffic goes through the
transport, which tunnels through `/wisp/`.

The wisp server is [holyWisp](https://github.com/Fracital/holyWisp), the C
server behind `wss://holywisp.fracit.al/`, so a local run relays the way
stomp.fracit.al does. The `holywisp` package runs its prebuilt binary
(Linux, macOS and Windows, x64 and arm64) as a child process on a free
loopback port, and the server hands it every `/wisp/` upgrade. It is set up
like the production edges (flood protection off, wisp messages of at most
256 KiB, a 64 MiB stream queue, literal IP addresses allowed, UDP relayed
for HTTP/3), except that `WISP_ALLOW_LOOPBACK` and `WISP_NO_UDP` apply. The
child never outlives
the server: it is stopped when the server exits or is ended by a signal, and
stops by itself when the server is killed outright. On a platform the
package has no binary for, build holyWisp and set `HOLYWISP_BIN`, or point
`STOMP_WISP_URL` at a wisp server elsewhere. With `STOMP_WISP_URL` set no
holyWisp is started.

## How the page works

`demo/public/pm/main.js`, in order:

1. **Register the service worker** at `/stomp/serviceWorker.js` with scope
   `/stomp/` and `updateViaCache: 'none'`, and hand the registration to the
   controller at once: the controller waits for the worker to activate
   before its first handshake, so the transport comes up while a first
   visit's worker installs. The landing page itself is outside that scope,
   which is fine: the controller only needs the registration to talk to.
2. **Load a transport.** The choice is remembered in `localStorage`
   (`stomp-demo:transport`). Transports are plain ES modules served from
   `/epoxy/` and `/libcurl/`, imported on demand. The epoxy descriptor has
   `http3` on (docs/http3.md) unless `STOMP_HTTP3=0` or `?http3=0` says
   otherwise.
3. **Create the controller**:
   ```js
   controller = new StompController({
   	serviceworker,
   	transport,
   	directory: '/stomp/',
   	codec: 'xor',
   	cache: CACHE,
   	onRequest: recordRequest,
   	onPermissionRequest: askPermission,
   });
   await controller.wait();
   frame = controller.createFrame(document.getElementById('frame'));
   ```
   Every tab's iframe carries an `allow` list (`FRAME_ALLOW`: geolocation,
   camera, microphone, the clipboard and the other powerful features), which
   isolation mode needs for a proxied page to reach the browser's
   permission prompts at all. STomp keeps each site's answer
   (docs/permissions.md); when a site asks for a permission the browser
   already gave the proxy for another site, `askPermission` shows the
   demo's own prompt (`#permissionPrompt`: Allow, Block, Close).
   The controller also gets `passkeys: { onRequest: askPasskey }`
   (docs/passkeys.md), in both modes: see [Passkeys](#passkeys).
   `wait()` resolves once the service worker has built a server for this
   controller. The controller is exposed as `window.controller` for devtools.
   No `id` is given, so the controller keeps the one the tab had last time
   (in `localStorage` as `kept-tab-ids`, one per tab open at once, held with
   a Web Lock): routed URLs stay the same from visit to visit and the
   browser keeps the compiled code of the scripts proxied pages load.
   `controller.cookies.clear()` forgets the kept ids with the cookies.
   The service worker's HTTP cache is on; `?nocache` on the demo URL turns it
   off for that visit. Emulated service workers (`serviceWorkers`,
   docs/service-workers.md) are on; `?nosw` turns them off for that visit;
   `?sw=<ms>` sets how long a worker may take to answer and
   `?swdelay=<ms>` makes its events reach the pages that much later (both
   for the suites).
   `onRequest` feeds the request viewer (below).
   The console has a plain `[wisp]` line for each event of the wisp
   connection (which carrier it is tried on and rides, and why not
   WebTransport); `?transportdebug`, or
   `localStorage['stomp:debug-transport'] = '1'` on the demo's origin and a
   reload, adds a `[net]` line for each connection to a site
   (`debugTransport`), as About's Transport log row says, and a `[wt]`
   line for each WebTransport session (a page's, and the carrier's own)
   naming the stage that failed (docs/webtransport.md, "Tracing a
   session").
4. **Suggestions.** Both address bars are the omnibox module
   (`dist/omnibox.js`, loaded by the name `STOMP_ASSETS.omnibox` gives, else
   the controller's `DEFAULT_ASSETS`): the open tabs to switch to (the top
   bar leaves out the tab on show), the pages the tabs visited (kept in this
   browser's localStorage under `omnibox:visits`, with the pages of the open
   tabs' own histories; Shift+Delete forgets one), the bookmarks, and Brave's
   completions, which `controller.suggest()` asks through the transport, so
   the demo's server never sees what was typed. Clicking the empty box
   shows the other tabs and the latest and most visited sites.
5. **Navigate** with `frame.go(url)` on the active tab. Input goes through `SearchBuilder`, so
   anything that doesn't look like a host becomes a search. The page's own
   address names no proxied page: each entry a tab shows is a token, the
   bare query `?1`, `?2`, and on, after the page's flags (`?nopool&3`), and
   what a token stands for (the tab, its entry, the URL and title) is kept in
   sessionStorage alone (`stomp-demo:session`, with the address bar's text
   under `stomp-demo:bar`). A reload or a restored session at a token brings
   the tabs back, the token's tab on show at its entry; a token the browser
   tab never wrote (a copied link, another window) opens home. A frame's
   navigation already adds a browser history entry, so the demo only
   replaces its address then; a dialed tab (the default,
   "Dialing" below) is never navigated, so each new entry of it is a
   `pushState`, and Back and Forward step the tab. A demo framed by its embedder (SystemYA's `/ui/`), or one
   whose `STOMP_CONFIG.addressFragment` is `'sealed'`, also writes the
   page's route as its fragment (`#html/<sealed>`, from `controller.route()`)
   for the embedder to read; a fragment, or one holding the URL itself (an
   older bookmark), still opens. Focus moves
   from the address bar into the tab's frame, as a browser gives the page it
   navigates to focus (`document.hasFocus()`, the keys typed next).
6. **Keep the address bar honest.** `frame.url` reads the real location of the
   proxied document (through its inject client), and the page polls it so
   `pushState` navigations inside the frame show up too. From the moment
   the demo navigates a tab until the new document commits, the address
   bar, the tab's card and the star show where it is going, as a browser's
   do, whatever the document it leaves still reports; a navigation that
   never commits (stopped by Stop, Reload or Back, answered with a 204 or a
   download, which the frame's `stayed` event says, failed, or still
   uncommitted after 30 s) shows the page the tab stayed on again. While the
   tab loads, Reload is Chrome's Stop (`frame.stop()`), and Escape in the
   page or on the toolbar stops the load too.
7. **Tabs.** Each tab is its own `controller.createFrame()`; only the active
   frame is visible. The landing page doubles as the new-tab page: submitting
   there or clicking a quick link opens a new tab. Closing the last tab goes
   back to the landing page. Below the address bar it shows the repository's
   latest commits, from `/api/commits`, kept current while the page is
   visible by `/api/commits/stream` (Server-Sent Events; when the stream
   fails, by asking `/api/commits` again each minute): the server's one
   poller asks GitHub about once a minute, conditionally and within its
   rate limit (`GITHUB_TOKEN` makes an unchanged list free), merges in this
   checkout's git log, which marks each commit `deployed` or not and is the
   answer when GitHub is out of reach, and pushes each change, so a push
   shows within about a minute and visitors cost GitHub nothing. A commit
   pushed but not deployed yet has a hollow dot; `STOMP_REPO` names another
   repository.
   Its links, like Fork us on GitHub, open in the proxy, never in the real
   browser: a click in the current tab, Ctrl, Cmd, Shift or the middle
   button in a new one. Chrome's tab keys are the demo's (`pm/main.js`,
   "the browser's keys"): Ctrl+R and F5 reload the tab, Ctrl+Shift+R,
   Shift+F5 and Ctrl+F5 hard-reload it (`frame.reload()` with
   `bypassCache`), never the demo's own page. Ctrl+T, Ctrl+Shift+T and Ctrl+W
   open, reopen and close the demo's tabs only where Chrome hands them to
   the page: in fullscreen (the demo also asks for them with the Keyboard
   Lock API) and in the installed app's window. In a Chrome tab Chrome
   keeps them before any page sees them, so they act on Chrome's own tab.
   Download, left of Fork us on GitHub, saves
   offline.html (below) with the page's wisp server written in.
8. **Navigation bar** at the bottom of the screen, styled after the early
   Android bar: Back steps through the active tab's own history (the frame
   reports whether it can step, from the browser's Navigation API, so mashing
   Back can never walk the host page out of the site; at the start of a tab's
   history Back goes home instead, and on the home screen it does nothing),
   Home shows the landing page, Recents opens the tab manager.
9. **Tab manager**, modelled on the One UI recent-apps screen. The cards are
   the real frames scaled down with CSS transforms (moving an iframe in the
   DOM would reload it), so each card is a live preview. Swipe or drag the
   stack sideways (mouse, touch or pen) to scroll through tabs, or use the
   mouse wheel and the arrow keys. Swipe a card upward to close it. Click the
   centred card to open it, a side card to centre it, the x to close it,
   Close all to close every tab, or one of the full-width quick-link buttons
   along the bottom to open that site in a new tab. Those buttons are the
   home screen's quick-link tiles: opening the manager from the home screen
   slides them from the tiles into the dock, and going home slides them
   back. Closing the last tab returns to the landing page. Enter opens the centred card and Escape
   closes the manager.
   Alt+Left / Alt+Right in the browser view call `frame.back()` /
   `frame.forward()`.
10. **Switching transports** calls `controller.setTransport(...)`. Requests in
    flight finish on the old transport; the next navigation uses the new one.
11. **Request viewer.** The controller's `onRequest(info)` reports every
    proxied request; the page keeps the last 300 per tab (matched on
    `info.frame`, dropped with the tab) and nothing else while the panel is
    closed. Long-press Recents (500 ms) or press Ctrl+Shift+X (in a proxied
    page too: a host hook in every proxied document, `KEY_HOOK`, hands the
    demo's keys over, Escape and Alt+Left/Right as well) and a panel slides
    up from above the
    navigation bar, in the switcher's style, with the active tab's requests,
    newest first: method, status (0 and the error in red on a transport
    failure), the real URL (host bold, path dimmed and ellipsised in the
    middle), destination, time, size and a `cached` tag when the service
    worker's cache answered. The header names the tab, counts requests, cached
    and failed, and has Clear. Rows that arrive while the panel is open land
    on top without moving a list the reader has scrolled. Only the URLs are
    selectable; clicking one copies it. Back, Escape, the same long press or
    shortcut close the panel; Home or a short Recents press take it down on
    their way. The page load itself is reported before the page has a client
    id (`frame` is null), so it is not attributed to a tab.

12. **Bookmarks.** The star in the address bar (and on each tab card)
    toggles the tab's page in a list kept in `localStorage`
    (`stomp-demo:bookmarks`): the real URL the address bar shows (a routed
    one goes through `controller.unroute`), the title, the page's
    description and its icon (`NavigateInfo.icon`, else the site's
    `/favicon.ico`). The host page
    never loads that icon itself: it is outside the service worker's
    scope, so the request would leave the proxy. A host hook in every
    proxied top document (`ICON_HOOK`, `hooks.init.pre`) posts the host a
    `MessagePort`, and any such page loads any bookmark's icon on request
    as an `<img>` the inject routes (no CORS or CSP stands in the way), read
    back with the `createImageBitmap` it took before the inject's hooks;
    the host draws it into a 64 px PNG `data:` URL. A bookmark without an
    icon is filled in whenever a page can ask (a port arriving, a page
    reporting, the list changing, on load), so one kept without an icon
    mends itself; the Tango globe stays only where the site has none. The
    same port answers the page's description (its meta description, else
    its `og:description`) when the user bookmarks it, and at no other time;
    it shows as a muted line under the title. The
    star tab on the home page's card, or Saved pages after Reload in the
    address bar, opens a sidebar listing the bookmarks; a click opens one
    in the current tab, the middle button or Ctrl in a new one, and a drag
    (a long press with a finger) or Alt+Up/Down reorders them. The
    first visit bookmarks Fracital, vibeOS, estrogen and Krunk, then the quick
    links Reddit, Google, YouTube and Discord at the URLs their tiles open,
    then the Chrome Web Store (which the Extensions page installs from)
    and N SVG (vibeOS's Nsvg, with vibeOS's icon for it), each once: `stomp-demo:bookmarks-seeded` keeps the URLs already offered
    (it was `1` when the defaults were the first four), so one the user
    removes stays removed and a default added later still comes to a list
    seeded before it. They carry curated icons and tile colours bundled in
    `pm/icons/`, and the titles and descriptions their pages gave. A
    default that changed (Estro became estrogen) updates in a profile
    seeded before: each field still at its old value takes the new one.

13. **Sign in with token (Discord).** A key button in the address bar, to the
    left of the status ticker, shows only on a discord.com page (its real
    host, read from the page's real URL) once that page has handed the host a
    `MessagePort` (`TOKEN_HOOK`, `hooks.init.post`). The user pastes their own
    Discord account token and it is written straight into that proxied page's
    own `localStorage`, so Discord logs in on reload, mirroring the well-known
    community bookmarklet. The token stays in the page's `localStorage` and
    never leaves the browser: it travels only over that same-browser
    `MessagePort` to the proxied Discord document, is stored nowhere else, and
    is never sent over the network or logged. The hook is a `post` hook so it
    writes the store the proxied page itself reads, and it runs before
    Discord's own scripts delete `window.localStorage`.

14. **Menu.** A button beside the address box, outside it (`#toolMenu`),
    opens the menu (`#pmMenu`). The menu is the tab's: the tab manager,
    which hides the bar, has only its New tab button. The menu is a popover
    built on the
    Shields panel's (`popover()` in main.js, `.popover` in main.css): it
    fades in, and closes at once by every way (its button, a click outside,
    Escape, an item chosen). **Fullscreen** calls `requestFullscreen()` on
    this page's root, not on a proxied frame, and `exitFullscreen()`; its
    label and icon follow `fullscreenchange`, so Escape or the browser
    leaving fullscreen shows too. Where the page cannot be made fullscreen
    (`document.fullscreenEnabled` false, as on an iPhone's Safari) the item
    is not offered. **Extensions** and **Themes** open submenus beside
    their items (on a click, under the pointer or with the right arrow;
    the left arrow and Escape close one alone). Extensions is Chrome 157's:
    Manage extensions and Visit Chrome Web Store, and on a bar with no room
    for the puzzle piece the installed extensions first. Themes lists
    `PMTheme`'s themes with a check on the one shown, then Get themes (the
    Web Store's themes) and Reset to default; without `PMTheme` the menu
    has no Themes. **Settings** opens the same dialog on the theme picker
    (view `settings`): Default, Light, Dark, Follow system and the themes
    installed from the Chrome Web Store (docs/themes.md).
    **Install powerMouse…**, before Settings, is there while Chrome offers
    to install the page ([The installed app](#the-installed-app)).
    **About** opens the Shields settings pages' dialog
    (`#shieldsPage`, view `about`): the version, build id, commit and build
    date from `/api/status` (`build`, the server's copy of
    `dist/build.json`, which `build.js` writes: the date is the commit's,
    never the build's time, so the build stays reproducible), then what the
    console badges said (mode, transport, controller) and the server's Node
    and uptime. While the dialog is open everything else in the page is
    inert and Tab goes round its controls; Escape, its Close button and its
    backdrop close it and the focus goes back to the menu button.

Errors from any step land in the status line (`Error: ...`) rather than the
console only.

## Passkeys

STomp is the passkey provider for proxied sites (docs/passkeys.md), on in
both modes. The service worker holds the keys and signs; nothing is made or
used until the user says so in this page, which no proxied page can click:

- **The sheet.** `askPasskey` asks in `#passkeyPrompt`, like Chrome's
  passkey sheet: "Create a passkey for `<site>`", naming the account, or
  one button per account that has a passkey for the site. A site that waits
  for a passkey in the background (conditional mediation) gets no sheet:
  the key button in the address bar (`#toolPasskey`) shows while its tab is
  in front and opens the chooser.
- **User verification.** A site is told the user was verified only when
  this page verified them with the platform's own authenticator (Windows
  Hello, Touch ID, the screen lock), which needs a secure context on a
  domain; without one sites see no user-verifying authenticator.
- **Seeing and deleting them.** Shields > Global Settings > Passkeys lists
  the saved passkeys by site (relying party id): the account, when it was
  made and last used, a Delete button for each and Delete all for each site
  (`controller.passkeys.list`, `delete` and `clear`).
- **Forget me.** "Forget me when I close this site" clears the site's
  passkeys with its other data: `forgetStorage` forgets those whose relying
  party id is the site's host or a suffix of it.

For the suites, `?passkeys=off` leaves the option out and `?passkeys=test`
takes a page's timeout as given, as Chrome takes it with a virtual
authenticator.
`?fedcm=test` ends a proxied page's FedCM requests without the delays
Chrome gives a token and a refusal, as Chrome does under DevTools'
`FedCm.enable`.

## The installed app

Chrome installs the page as an app named powerMouse, which opens in a
window of its own (Chrome 157):

- **The manifest.** `public/manifest.webmanifest`: id, start_url and scope
  `/`, display `standalone` with `window-controls-overlay` first in
  `display_override`, the icons in `public/pm/icons/` (`app-192.png`,
  `app-512.png`, and `app-maskable-512.png` with the logo inside the
  maskable safe zone), and shortcuts for New tab, Extensions and Settings.
  `display_override` has no `tabbed`: Chrome's tab strip would be a second
  row of tabs over the page's own, each Chrome tab a separate page with
  its own controller. `launch_handler` is `focus-existing`: a launch
  never reloads the window and its tabs. A shortcut, a `web+stomp:` link
  (`protocol_handlers`) and a URL shared to the app (`share_target`)
  arrive as `?launch=` (or `?url=` and `?text=`) on the page's address or
  through `launchQueue`, and `pm/main.js` opens the home screen, the
  Extensions page, Settings or a tab at the address, then takes the
  query off the address. A link is `web+stomp:<address>`, with or
  without `//`.
- **The app worker.** `public/app-worker.js`, registered with scope `/`
  once the proxy is up (Chrome and its kin only: elsewhere nothing installs
  the page). STomp's worker keeps `/stomp/`, and a narrower scope always
  wins, so no proxied page, frame or request reaches it. Its static routes
  (`InstallEvent.addRoutes`) send every request but the load of `/` to the
  network without starting it; that load goes out by navigation preload
  and, when the network is down, the worker answers with a page that says
  powerMouse is offline, in the theme last shown, and loads the app again
  once the site answers. Chrome 157 finds the page installable without the
  worker as well (`Page.getInstallabilityErrors` is empty either way).
- **Where.** `index.html` links the manifest only on the top page at the
  site's root (`/` or `/index.html`), and `pm/main.js` registers the app
  worker only where the manifest is: a copy of the page in a frame or
  under another path (a host that ships this page inside its own) is no
  app, and a root worker there would be the host's.
- **The window.** The menu has Install powerMouse… while Chrome offers the
  app (`beforeinstallprompt`), never in the app's own window (display-mode
  `standalone`, `window-controls-overlay` or `minimal-ui`). With Window
  Controls Overlay the browser view's bar is the title bar: its free space
  and a gap beside the window's controls drag the window, its buttons and
  the address box do not, and the home screen has a strip of the title
  bar's height to drag by. `<meta name="theme-color">`, the colour of the
  title bar and of the window controls' strip, is the theme's
  (`pm/theme.js`): the toolbar's in the browser view, the page's on the
  home screen.
- **Keys.** In an app window Chrome reserves none of its shortcuts
  (`BrowserCommandController::IsReservedCommandOrKey`,
  `BrowserView::PreHandleKeyboardEvent`): Ctrl+T, Ctrl+W, Ctrl+N,
  Ctrl+Shift+T, Ctrl+Shift+N, Ctrl+Tab and the rest reach the page first,
  and Chrome acts on one only when the page does not call
  `preventDefault()`. In a tab Chrome takes the reserved ones (close tab
  or window, new tab, window or incognito window, reopen closed tab, next
  and previous tab, quit) before the page sees them, except in
  fullscreen, where only the fullscreen key and quit stay Chrome's.

`test/suites/pwa.mjs` checks the manifest, Chrome's reading of it, the
app worker, the menu item, theme-color, the launches, the offline page,
the app window (`PWA.install`, `PWA.openCurrentPageInApp`) and the copies
elsewhere; its header lists what headless Chrome cannot show.

## Transports

The transport switch has epoxy (the default) and libcurl, remembered in
`localStorage` as `stomp-demo:transport`.

- epoxy is the build `deploy/epoxy/` makes, not the npm package: HTTP/1.1,
  HTTP/2 and HTTP/3, Chrome's TLS and HTTP/2 fingerprint, and WebSocket
  frames both ways. The npm package held each WebSocket frame the page
  wrote in the wisp stream until the next write, so incoming frames seemed
  to stop after the first round trip; the build flushes every frame
  (epoxy-tls patch 0061, the `websocket-frames` suite runs both
  transports in both modes).
- libcurl is `@mercuryworkshop/libcurl-transport` from npm. Against
  `wisp-js` 0.5.2 its HTTP stopped answering after roughly 70 requests
  with its default pool and roughly 160 with the larger one the demo passes
  (`connections: [500, 400, 200]`), and it answers no WebSocket ping (the
  changelog's known limitations). It has no UDP, so no HTTP/3, WebRTC or
  WebTransport, and Wisp always rides the WebSocket.

Use epoxy. libcurl is there to tell a transport bug from a STomp one: a site
that fails the same way on both fails in STomp.

## offline.html

`npm run build` ends with `scripts/build-offline.mjs`, which writes
`build/offline.html`: this page and STomp in one HTML file of about 10 MB
that runs from `file:` or any static host with no service worker
(`npm run build:offline` makes only it; nothing goes into `dist/`).
`dist/serviceWorker.js` runs unchanged in a dedicated worker the page starts
(`demo/offline/worker.mjs` gives it a service worker's scope there), and each
document of a tab is written into a frame of its own that loads one fixed
page and fetches its route through that worker (`demo/offline/host.mjs`).
The bundles, wasm modules and transports are gzipped in a JSON payload.

The file is a build output, like `dist/`: `/build` is in `.gitignore`, so
it is never committed, and it is not in the npm package (`package.json`
`files` is `dist` and `lib`). A host gets it from a server that serves it
(below), not from `@sysce/stomp`.

The wisp server it tunnels through is JSON in one element at the top of its
head: `wss://holywisp.fracit.al/` as built (`STOMP_OFFLINE_WISP` names
another), which the home page's Download replaces with the page's direct
wisp server (`STOMP_CONFIG.wisp`, key path and all, else this server's
`/wisp/`). Never the Tor relay: the file has no Tor mode, and with Tor on,
Download's title says the copy is direct. In the file itself, `?wisp=` and
Settings > Wisp server change the wisp server, and Download is not shown.
Settings saves the choice and restarts without the `wisp` query. The
current tab keeps the choice in its history entry, so a reload works even
if the browser does not keep `file:` storage. A copy that names a relay
whose key changes stops reaching it until Settings names the new one.

### Serving it

The server serves `/offline.html` and `/offline.html.sha256`
(`<sha256>  offline.html`). It builds the file itself, in the background,
when `build/offline.html` is missing or names another tree's key
(`scripts/offline-key.mjs`: dist/build.json and every other file the build
reads, the key in the file's first comment), writing a temporary file and
renaming it, so a deploy that copies only `dist/` serves the current one.
`STOMP_OFFLINE_FILE` puts the file elsewhere. Both routes answer:

| Case                   | Status | Headers                                                                                                                                                                                    |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the file is current    | 200    | `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: ETag`, `ETag: "<sha256 of the file>"`, `Cache-Control: no-cache`; `/offline.html` also `Content-Disposition: attachment` |
| `If-None-Match` agrees | 304    | the same                                                                                                                                                                                   |
| being built            | 503    | `Retry-After: 5`, `Cache-Control: no-store`, the CORS pair                                                                                                                                 |
| its build failed       | 503    | `Retry-After: 60` (tried again a minute later), the rest as above                                                                                                                          |

The ETag is the file's SHA-256 and changes with every deploy that changes
the file under the same name; `no-cache` makes every fetch revalidate. A
GET without custom headers is a simple CORS request, so there is no
preflight, and a page under `Cross-Origin-Embedder-Policy: require-corp`
(this one, a host's) may read it because the answer is CORS.

### A host that vendors the page (SystemYA)

Download fetches the file from `/offline.html`, or from
`STOMP_ASSETS.offline` where the host sets it before `pm/main.js`: a URL,
another origin's too, or a name resolved against the controller's
directory (`/stomp/`, `/stomp-tor/` with Tor on) as the service worker's
name is. No other name of the host's contract changes. For SystemYA's
`/ui/` copy the intended value is
`STOMP_ASSETS.offline = 'https://stomp.fracit.al/offline.html'`, so nothing
is vendored and the saved copy carries SystemYA's own direct wisp server;
that value is not set there yet and needs the infrastructure's agreement.
The save is a click on a `blob:` link made after the fetch. A frame
without a `sandbox` attribute (SystemYA's `/app/` frames `/ui/` that way)
saves it; a sandboxed one saves it only with `allow-downloads`, and Chrome
refuses it silently otherwise, the button showing nothing (the
offline-html suite checks both). The names a host's contract gains:
`STOMP_ASSETS.offline`, `#offlineDownload` in `index.html`, and
`pm/icons/document-save-24.png` and `-32.png`. A host that leaves
`STOMP_ASSETS.offline` unset and does not serve `/offline.html` gets "Not
available" on the button for three seconds.

### What it cannot do

Measured in headless Chrome 157 and 158 only, from `file:` (the
offline-html suite; a static host was tried by hand when it was written):

- It reads its payload with `Uint8Array.fromBase64` and
  `DecompressionStream`, so an older browser stops at the start. A phone
  cannot open a saved HTML file as a page, so Download is hidden below
  480 px.
- With no service worker there is no sync bridge, and the transport runs
  on the page's own thread (a `file:` page can start no SharedWorker, and
  the transports' modules are mapped in this page only): a proxied page's
  synchronous XMLHttpRequest fails.
- No site pool or isolation: every proxied document is written into a
  frame of the file's own origin (`file:` or the static host's), as with
  the same-origin controller. It is not a security boundary.
- Not modelled yet: `response.url` and `responseURL` (read as `''`), a
  page's own history (`pushState`, `history.length`, `popstate`), a header
  CSP, saving a page's downloads (they are shown), nested proxied frames,
  a page's Workers and SharedWorkers, EventSource, `sendBeacon`, emulated
  service workers of pages, rewrite workers, streaming media, and the
  non-SIMD epoxy build. A held script runs after the markup after it.
- Its profile (cookies, site storage, Settings, themes) is the browser's
  storage for the `file:` page, not a site's. Chrome was seen to reopen a
  file before its last `localStorage` write showed, which is why the wisp
  choice is kept in the history entry as well.

### Licences

A one-line comment after the doctype names the licence (GPL-3.0-only) and
the source commit, and a comment ends the file with
`scripts/offline-notices.mjs`'s notices: STomp's licence, each npm package
in a bundled file (read from the bundles' source maps) or carried whole
(the transports, libcurl.js and its C libraries' notice, the font), each
with its licence file or a notice held in `demo/offline/notices/` (the
epoxy fork, which ships no LICENSE, the adblock engine and lists, the
Tango icons, the Powermouse style), the Public Suffix List's header, and
the Rust crates of every wasm module it carries (`core.wasm`,
`codec.wasm`, `blocker.wasm`, `epoxy-simd.wasm`, `stomp_h3_bg.wasm`) by
module, name, version and licence, then each crate's own licence and
notice files, and the standard library's licences. The build fails when a
bundled package has neither a licence file nor a held notice. The crates'
part comes from `demo/offline/notices/crates.json`, which
`node scripts/crate-notices.mjs` writes by asking cargo in the containers
that build the modules (`deploy/rust`'s toolchain image, and
`deploy/epoxy`'s image of the pinned epoxy build, whose lockfile is in no
checkout of this repository), so the build itself needs no cargo. The
build fails when `rust/Cargo.lock` or `deploy/epoxy/h3/Cargo.lock`
resolves other crates for a module, or the installed epoxy transport is
another build, than the file was written for: run the script again.
`dist/` still ships those wasm modules without the crates' notices.

## Files

```
demo/
├── server.js           Express + holyWisp host
├── offline/            offline.html's page side: boot, the emulated worker, frames, notices
├── public/
│   ├── index.html      landing + browser chrome markup
│   ├── favicon.ico
│   ├── manifest.webmanifest, app-worker.js
│   │                   the installed app (The installed app, above)
│   └── pm/
│       ├── main.css    Powermouse-derived styling
│       ├── main.js     controller wiring and UI behaviour
│       ├── theme.js    the themes and PMTheme (docs/themes.md), before first paint
│       ├── extensions-page.js, extensions-page.css
│       │               the Extensions page, after chrome://extensions
│       ├── dev.js      live reload client, npm run dev only
│       ├── noise.png, header-background.png, logo.png
│       └── icons/      the bar's, the menu's and the bookmarks' icons,
│                       and the app's (app-192.png, app-512.png,
│                       app-maskable-512.png)
└── README.md
```

## Origin isolation

Opened at `http://localhost:8080`, the page uses `http://127.0.0.1:8080` as
the proxy origin. Same server, two origins, so proxied pages are cross-origin,
sandboxed frames that can neither read the demo page nor navigate it. On any
other hostname the proxy origin comes from `STOMP_PROXY_ORIGIN`; without it
(and at `http://127.0.0.1:8080`) the origins coincide and the demo runs the
same-origin `StompController`, which the version line says. That mode is not a
security boundary: a proxied page that breaks out of the rewriter shares the
origin of the host page. The live demo at https://stomp.fracit.al runs this
way on purpose, with one hostname.

`localhost` and `127.0.0.1` are two sites, so the proxy frame is a
third-party frame, and a browser that blocks third-party cookies (Brave and
incognito windows by default, a setting in Chrome) gives it no service
worker. The page then runs the same-origin controller on `localhost` and
says why in an orange `Isolation` console badge. With `STOMP_PROXY_ORIGIN`
set the failure is an error instead: that deployment asked for isolation.
To see the isolated mode in such a browser, allow third-party cookies for
`localhost:8080`.

What the isolated mode consists of:

- `dist/controllerFrame.html`, embedded hidden by `RemoteController`. It
  registers the service worker on the proxy origin, loads the transport
  module (which must also live on the proxy origin) and runs the real
  controller. Its `<meta name="stomp-allowed-origins">` lists the host
  origins allowed to drive it, space separated; left empty, it trusts the
  page that embedded it (the parent's origin, read once at load; a page
  that sends no referrer is asked, and the browser names the origin of its
  answer). Set it for a real deployment: a page of an origin it does not
  list, or of an opaque origin, gets an `EmbedderRefusedError` from
  `wait()`.
- Proxied frames get `DEFAULT_SANDBOX`:
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-storage-access-by-user-activation"`
  (the same list in the same-origin mode).
  `allow-same-origin` is required so the proxy origin's service worker
  controls the frame; `allow-top-navigation` is deliberately absent so
  `top.location = ...` throws instead of navigating the host.
- The service worker sends every proxied document
  `Content-Security-Policy: frame-ancestors 'self' <host>` (with the site
  pool's origins when there is one), so only the host application and the
  proxy origin's own pages can frame the proxy origin.
- Navigation controls (back, forward, reload) and the address bar's URL and
  title are relayed through the controller frame, which is same-origin with
  the proxied pages; the host page never touches them directly.

## Site pool

Off by default. With `STOMP_SITE_POOL` set the server answers on more
ports (a number of free ports to take, `5`, or a list, `8081,8082`; `0`,
the default, or `off` for none), and the controller shows every proxied
site from one of them (`init.sitePool`, docs/site-pool.md): the browser gives each port's
origin a process of its own, so a page and a frame of another site in it
are apart as natively. The `Mode` badge says so, and `?nopool` leaves the
pool out for a visit. The controller embeds a hidden agent frame on each
port in use, which registers that origin's service worker; the tabs are
frames on the pool's origins, so the address bar's URL and title come from
the pages' reports and Back and Forward go through the agents. Both pages
use it, the same-origin one and isolation mode's.

Behind a front (a reverse proxy or a CDN) the slots are the front's
ports: `STOMP_SITE_POOL_PUBLIC` lists them (`8443,8444,8445`), the front
forwards each to the server and says which one with
`X-Forwarded-Port`, and everything those ports answer must keep the
server's `Origin-Agent-Cluster: ?1`. A page that came through a front with
no `STOMP_SITE_POOL_PUBLIC` has no pool; a slot the browser cannot reach
is left out for the page and its sites are shown from the page's own
origin (docs/site-pool.md, Fallbacks).

## Content slots

Off by default. With `STOMP_SLOT_PORTS` set (a list, or a number of free
ports) the server answers on those ports as on its own, with
`Origin-Agent-Cluster: ?1`, and the page, which dials ("Dialing"
below), gives them to its controller as its site pool,
with no spare slot (`warm: false`): each proxied site is written into the
call page of its slot, an origin and a renderer process apart from the
UI's, and a slot's service worker is registered only when the first site
is shown from it (docs/content-slots.md). One port is enough to keep the
pages off the UI's thread; more give the sites processes of their own.
The classic tabs never use them. Behind a front,
`STOMP_SLOT_PORTS_PUBLIC` lists the front's ports (production's are 2053,
2083, 2087 and 2096, docs/content-slots-deploy.md), as
`STOMP_SITE_POOL_PUBLIC` does for the pool. Without them, with `?nopool`,
or where a slot does not answer, the page writes the sites on its own
origin. The ports are not a cookie boundary and not a sandbox.

## Cross-origin isolation

Every response of the server carries
`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` and
`Cross-Origin-Resource-Policy: cross-origin`. The first two make the page
cross-origin isolated, and STomp, which reads that at run time, then lets a
proxied page be isolated when its own headers isolate it natively
(SharedArrayBuffer, the precise clock); every other proxied page has what a
page without isolation has. The embedder policy on the other files is for
the workers the controller starts from `/stomp/` (a worker of an isolated
page starts only when its script has one), and with the third header for the
isolated mode, where the page embeds the controller's frame from the proxy
origin: a frame of an isolated page loads only with an embedder policy and,
from another origin, with that resource policy.

`require-corp` rather than `credentialless`: in Chrome and Firefox both
isolate, but WebKit (Safari, and every browser on iOS) has no
`credentialless`, and a page that sends it is not isolated there, so no
proxied page was: a game that needs SharedArrayBuffer (blockshooter.club)
ran natively and stopped at its isolation check through the demo. Under
`require-corp` everything the page itself loads from another origin sends a
Cross-Origin-Resource-Policy. The commit list's avatars do not come from
another origin: the server fetches them from GitHub and serves them itself. The service worker serves the proxied documents and workers
with `require-corp` too (src/isolation.ts `SERVED_EMBEDDER_POLICY`).

`STOMP_ISOLATION=off` leaves the three headers out. Nothing is isolated
then, and everything else is the same. The suites run that way
(test/run.mjs) except `cross-origin-isolation`, `sop-escapes` and
`popup-openers`: under an
isolated page whose proxy is on another origin, Chrome gives the proxied
frames no window for the popups they open, and the suites open real popups
(the demo's own page takes them as tabs with `onOpen`, so it loses nothing).
`STOMP_ISOLATION=on npm test -- <suite>` runs a suite under the isolated
host. docs/same-origin-policy.md, "Cross-origin isolation", has the
measurements.

## Dialing

The page dials its tabs (`justCallStomp`, docs/dialing.md): each document
is written into one constant call page instead of the frame navigating to
the site. The page's controller is made with `dialing: true`. It shows the
classic tabs (each frame navigated to its page's route under `/stomp/`,
the controller without `dialing`, so the service worker has no call page
and answers no call) only where it cannot dial, and no address of the page
asks for them:

- the browser lacks the Navigation API, which a dialed document's history
  is (`justCallStomp()` throws `NotSupportedError` there): the status line
  says `Ready (classic tabs: this browser lacks the Navigation API)` and
  About's Dialing row says why; a library that refuses for a reason the
  page did not foresee loads the page again with the classic tabs, never
  leaving a tab blank;
- the server names a proxy origin (`STOMP_PROXY_ORIGIN`): the remote
  controller does not dial yet. On `localhost` with none, whose classic
  tabs were the isolated mode, the page dials on its own origin;
- offline.html, which writes its documents into call pages of its own;
- a server run with `STOMP_DIALING=0`, for the test suites of the classic
  path (test/run.mjs, `dials()`); there `?mode=just-call-stomp` dials again,
  for the suites that check both side by side.

What the browser has for a dialed frame (its `src` and its real location) is
the call page's URL alone, `<scope><callPage>`, with `?1`, `?2` for the frames
of its documents. So that this names nothing, the mode does not use
`/stomp/`: the server derives a scope and a page name from the machine's
name and the checkout's path, the same at every start, so a tab open across
a restart keeps a scope the server serves (`/3dee0ce3/c2866a19.html`, and
another scope for Tor mode), tells the page in
`/config.js` (`dial: { directory, torDirectory, page }`) and serves `dist/`
there too. `STOMP_DIAL_DIRECTORY` (`/<name>/`) and `STOMP_DIAL_PAGE` (`<name>`)
fix them instead. A host that sets `STOMP_ASSETS.callPage` keeps its own name
for the page. `test/suites/dial-urls.mjs` walks the mode and checks every
frame's URL at every step, and that the classic tabs have no call page;
`test/suites/dial-default.mjs` that the page dials with no address asking,
and falls back where the browser has no Navigation API.

For a host that vendors the bundle under neutral names (SystemYA's
`scripts/prepare-stomp.mjs`): `callPage` is a new key of
`StompController.DEFAULT_ASSETS`, so a check that compares the keys with its
own list sees it. It names no file in `dist/`: give it a stamped neutral name
like the others (`pg.<stamp>.html`) in the `assets` the controller gets, and
copy nothing for it. The scope it lives under is the host's `directory`, which
should be neutral too (`/vendor/rt/` is). The demo's page dials by default,
so a host of the page that gives it no `dial` config dials on its own
`directory`.

## vibeOS

The tab manager's desktop button and the menu's vibeOS item switch the page to
vibeOS (the `vendor/vibeOS` submodule, built into `dist/vibeos/` and served
under a neutral directory, `/<8 hex>/`, its games' pages under neutral
directories inside it; `config.js` says `vibeos` only when the build has it).
Nothing of it loads before the first switch, which imports its module. Each
tab becomes a window of vibeOS's browser holding the tab's own frame element,
moved there with `moveBefore`, so no tab reloads either way; the browser's tabs
are the page's tabs (`vibeHost` in pm/main.js), and its menu is the page's
menu. Without `moveBefore` the frames stay in `#frames` and are laid over
their windows. Details in [`docs/vibeos.md`](../docs/vibeos.md).

## Deploying somewhere real

https://stomp.fracit.al is this directory, deployed by
`.github/workflows/deploy.yml` on every push to `master`: the workflow builds,
then asks the server over SSH to run the deploy gate
(`deploy/terp-deploy-gate.sh`) for that commit. The gate clones and builds a
staging checkout, swaps the live checkout to it, restarts the Node process
and rolls back if `/api/status` does not come up. A reverse proxy in front
terminates TLS and forwards the host name to the server's port, with no CDN
in between. The server's `.env` holds `PORT` and `STOMP_WISP_URL`, which
points the transports at the holyWisp relay behind
`wss://holywisp.fracit.al/`, so the demo server's built-in wisp is off
there.

For your own deployment:

- For isolation, use two hostnames: one for the host application, one (the
  proxy origin) for `dist/`, the transports, wisp and the proxied content.
  One server can serve both; the demo server does. Set `STOMP_PROXY_ORIGIN`
  to the second one and fill in `stomp-allowed-origins` in
  `controllerFrame.html`. A wildcard certificate covers one subdomain
  level, so `name-proxy.example.com` is covered by the same certificate as
  `name.example.com` where `proxy.name.example.com` is not.
- For cross-origin isolation, the page and (with two hostnames) the proxy
  origin's files must keep the three headers above through whatever is in
  front of the server; a proxy or CDN that drops them leaves the page not
  isolated, and the demo then runs as it did without them.
- Serve the page over HTTPS; the script picks `wss://` for the wisp URL
  automatically from `location.protocol`.
- Keep `dist/`, the transports and the page on the same origin. The service
  worker scope and `directory` must match the path `dist/` is mounted at.
- Run wisp with its default filters (the loopback opt-in is for local QA).
- The page, its scripts, `/stomp/` and the transports are served with
  `Cache-Control: no-cache` so browsers revalidate and CDNs do not pin a
  stale service worker or shell to a new build; fonts may be cached for a
  day. What is asked for by the hash of its bytes is kept for good instead:
  STomp asks for the rewriter library, the core module, the document
  bundles, the transport and rewrite workers, the blocker's module,
  isolation mode's controller frame and its script, and the site pool's
  frame script as `<name>?<hash of its bytes>`, the page names its scripts, its stylesheet
  and its images so (`demo/server.js` writes the hashes into `index.html` as
  it serves it), and it loads each transport from under the hash of its
  package's files (`/epoxy/<hash>/index.mjs`, from config.js `transports`:
  a path segment, because epoxy.wasm and stomp-h3 are fetched relative to
  the module and would lose a query). `demo/server.js` answers such a URL
  with `immutable` only when the hash is the file's own (a page of the
  build before a deploy asks by the old hash, and gets `no-cache`), so a
  reload revalidates only the page, the service worker's script and the
  images the stylesheet names. The page itself stays `no-cache`: it is what
  names the current hashes. The plain names keep working, `no-cache`.
  The demo also registers with `updateViaCache: 'none'`. A CDN in front
  may apply a browser cache lifetime of its own over the origin's headers:
  set it to respect the origin's `Cache-Control`.
