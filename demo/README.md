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
| `STOMP_REWRITER`          | unset          | `wasm` runs the Rust rewriters where a thread holds them (the controller's `rewriter` option; `?wasm` does one visit, `?js` the JavaScript ones)                                                                                                                                                                                                                          |
| `STOMP_ADBLOCK`           | on             | Set to `0` to turn off the content blocker (docs/adblock.md), a JSON object is its `adblock` option; `?noadblock` and `?adblock` do one visit, the toggle is kept                                                                                                                                                                                                         |
| `STOMP_ECH_DNS`           | Cloudflare DoH | DNS-over-HTTPS endpoint epoxy asks for HTTPS records to offer real Encrypted Client Hello (docs/fingerprint.md); `off` sends GREASE ECH only (`?noech` does one visit)                                                                                                                                                                                                    |
| `STOMP_SITE_POOL`         | unset          | More ports to answer on, a list or a number of free ones to take: the slots of the site pool (see Site pool; `?nopool` on the page leaves it out for a visit)                                                                                                                                                                                                             |
| `STOMP_TEST_TRANSPORT`    | unset          | Set to `1` to use `/test/mixed-transport.mjs` (epoxy that reaches the suites' fixture hosts: mixed-content's, and the names under a private suffix); test runs only                                                                                                                                                                                                       |

They can also live in a `.env` file next to `package.json` (not committed);
the server reads it at startup. The page gets what it needs from `/config.js`.

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

| Path           | Serves                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `/`            | `demo/public` (the page, stylesheet, script, images)                                              |
| `/stomp/`      | `dist/` via `stompPath` from `@sysce/stomp/path`                                                  |
| `/epoxy/`      | `@mercuryworkshop/epoxy-transport`'s `dist/`                                                      |
| `/libcurl/`    | `@mercuryworkshop/libcurl-transport`'s `dist/`                                                    |
| `/wisp/`       | WebSocket upgrade handed to holyWisp (the `holywisp` package), see below                          |
| `/api/status`  | `{ uptime, version, node, build }` for the landing page footer and the menu's About               |
| `/api/commits` | `{ repo, url, commits }` for the landing page's latest commits: GitHub's answer, kept ten minutes |

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
   `/stomp/` and wait until it is `activated`. The landing page itself is
   outside that scope, which is fine: the controller only needs the
   `ServiceWorker` object to talk to.
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
   (`debugTransport`), as About's Transport log row says.
4. **Autocomplete.** Each keystroke in an address bar posts what was typed
   to `/suggestions` (in the body, so no URL names the site) for public
   suffixes matching what was typed after
   the last dot (the server loads the public suffix list at startup, with a
   built-in fallback). Suffixes that start with the typed text come first,
   most common first; clicking one swaps it into the address bar.
5. **Navigate** with `frame.go(url)` on the active tab. Input goes through `SearchBuilder`, so
   anything that doesn't look like a host becomes a search. The proxied page
   is mirrored into `location.hash` by its route (`#html/<sealed>`, from
   `controller.route()`, read back with `controller.unroute()`), so a refresh
   restores the page and the host's address does not name it; a fragment
   holding the URL itself (an older bookmark) still opens. Focus moves
   from the address bar into the tab's frame, as a browser gives the page it
   navigates to focus (`document.hasFocus()`, the keys typed next).
6. **Keep the address bar honest.** `frame.url` reads the real location of the
   proxied document (through its inject client), and the page polls it so
   `pushState` navigations inside the frame show up too. From the moment
   the demo navigates a tab until the new document commits, the address
   bar, the tab's card and the star show where it is going, as a browser's
   do, whatever the document it leaves still reports; a navigation that
   never commits (stopped by Reload or Back, failed, or still uncommitted
   after 30 s) shows the page the tab stayed on again.
7. **Tabs.** Each tab is its own `controller.createFrame()`; only the active
   frame is visible. The landing page doubles as the new-tab page: submitting
   there or clicking a quick link opens a new tab. Closing the last tab goes
   back to the landing page. Below the address bar it shows the repository's
   latest commits, from `/api/commits` (the server's ten-minute copy of
   GitHub's answer; `STOMP_REPO` names another repository).
   Its links, like Fork us on GitHub, open in the proxy, never in the real
   browser: a click in the current tab, Ctrl, Cmd, Shift or the middle
   button in a new one.
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
    first visit bookmarks Fracital, vibeOS, Estro and Krunk, then the quick
    links Reddit, Google, YouTube and Discord at the URLs their tiles open,
    each once: `stomp-demo:bookmarks-seeded` keeps the URLs already offered
    (it was `1` when the defaults were the first four), so one the user
    removes stays removed and a default added later still comes to a list
    seeded before it. They carry curated icons and tile colours bundled in
    `pm/icons/`, and the titles and descriptions their pages gave the public
    demo.

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
    and its twin beside New tab in the tab manager, which hides the bar
    (`#recentsMenu`), open one menu (`#pmMenu`), a popover built on the
    Shields panel's (`popover()` in main.js, `.popover` in main.css): it
    fades in, and closes at once by every way (its button, a click outside,
    Escape, an item chosen). **Fullscreen** calls `requestFullscreen()` on
    this page's root, not on a proxied frame, and `exitFullscreen()`; its
    label and icon follow `fullscreenchange`, so Escape or the browser
    leaving fullscreen shows too. Where the page cannot be made fullscreen
    (`document.fullscreenEnabled` false, as on an iPhone's Safari) the item
    is not offered. **About** opens the Shields settings pages' dialog
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

## Transports

Both bundled transports had a defect against `wisp-js` 0.5, the demo's wisp
server before holyWisp (measured with and without STomp in the path, see the
changelog's known limitations):

- **epoxy** (default): HTTP is fast and reliable; incoming WebSocket frames
  stop after the first round trip.
- **libcurl**: WebSockets work; HTTP stops answering after roughly 160
  requests even with the enlarged connection pool the demo passes
  (`connections: [500, 400, 200]`).

Pick epoxy for browsing, libcurl when you need sockets.

## Files

```
demo/
├── server.js           Express + holyWisp host
├── public/
│   ├── index.html      landing + browser chrome markup
│   ├── favicon.ico
│   └── pm/
│       ├── main.css    Powermouse-derived styling
│       ├── main.js     controller wiring and UI behaviour
│       ├── dev.js      live reload client, npm run dev only
│       ├── noise.png, header-background.png, logo.png
│       └── icons/      the bar's, the menu's and the bookmarks' icons
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
  page that embedded it (taken from the referrer once, at load). Set it for
  a real deployment.
- Proxied frames get
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"`.
  `allow-same-origin` is required so the proxy origin's service worker
  controls the frame; `allow-top-navigation` is deliberately absent so
  `top.location = ...` throws instead of navigating the host.
- The service worker adds `Content-Security-Policy: frame-ancestors <host>`
  to every proxied document, so only the host application can frame the
  proxy origin.
- Navigation controls (back, forward, reload) and the address bar's URL and
  title are relayed through the controller frame, which is same-origin with
  the proxied pages; the host page never touches them directly.

## Site pool

On by default. The server answers on five more free ports
(`STOMP_SITE_POOL`: a number of free ports, or a list, `8081,8082`; `0` or
`off` for none), and the controller shows every proxied site from one of
them (`init.sitePool`, docs/site-pool.md): the browser gives each port's
origin a process of its own, so a page and a frame of another site in it
are apart as natively. The `Mode` badge says so, and `?nopool` leaves the
pool out for a visit. The controller embeds a hidden agent frame on each
port in use, which registers that origin's service worker; the tabs are
frames on the pool's origins, so the address bar's URL and title come from
the pages' reports and Back and Forward go through the agents. Both pages
use it, the same-origin one and isolation mode's.

Behind a front (Cloudflare, OpenResty) the slots are the front's ports:
`STOMP_SITE_POOL_PUBLIC` lists them (`2053,2083,2087,2096,8443`), the
front forwards each to the server and says which one with
`X-Forwarded-Port`, and everything those ports answer must keep the
server's `Origin-Agent-Cluster: ?1`. A page that came through a front with
no `STOMP_SITE_POOL_PUBLIC` has no pool; a slot the browser cannot reach
is left out for the page and its sites are shown from the page's own
origin (docs/site-pool.md, Fallbacks).

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
Cross-Origin-Resource-Policy: GitHub's avatars in the commit list send
`cross-origin`. The service worker serves the proxied documents and workers
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

## Deploying somewhere real

https://stomp.fracit.al is this directory, deployed by
`.github/workflows/deploy.yml` on every push to `master`: the workflow builds,
then asks terp (the Fracital VPS) over SSH to run `deploy/terp-deploy-gate.sh`
for that commit. The gate clones and builds in `/opt/stomp/stage`, swaps
`/opt/stomp/repo` to it, restarts the pm2 app `stomp` on :8081 and rolls back
if `/api/status` does not come up. terp's OpenResty routes the `stomp.fracit.al`
host to that port (the vhost is in abulxt's `fracital_origin` ansible role,
`fracital_origin_apps`); the abulxt edge fleet terminates TLS and relays to
terp, and Cloudflare fronts the edges with a proxied CNAME. terp's
`/opt/stomp/repo/.env` holds `PORT` and `STOMP_WISP_URL`, which points the
transports at the edges' keyed wisp relay (`wss://holywisp.fracit.al/pipe/<key>/`,
served by each edge's own holyWisp instance), so the demo server's built-in
wisp is off there.

For your own deployment:

- For isolation, use two hostnames: one for the host application, one (the
  proxy origin) for `dist/`, the transports, wisp and the proxied content.
  One server can serve both; the demo server does. Set `STOMP_PROXY_ORIGIN`
  to the second one and fill in `stomp-allowed-origins` in
  `controllerFrame.html`. Cloudflare's universal certificate covers one
  subdomain level, so prefer `name-proxy.example.com` over
  `proxy.name.example.com`.
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
  The demo also registers with `updateViaCache: 'none'`. Behind Cloudflare,
  check the zone's Browser Cache TTL: it overrides origin headers unless a
  cache rule for the host says "respect origin" (stomp.fracit.al and
  holywisp.fracit.al have one).
