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
| `STOMP_ADBLOCK`           | on             | Set to `0` to turn off the content blocker (docs/adblock.md), a JSON object is its `adblock` option; `?noadblock` and `?adblock` do one visit, the toggle is kept                                                                                                                                                                                                         |
| `STOMP_ECH_DNS`           | Cloudflare DoH | DNS-over-HTTPS endpoint epoxy asks for HTTPS records to offer real Encrypted Client Hello (docs/fingerprint.md), and HTTP/3 asks for a name's first request (docs/http3.md); `off` sends GREASE ECH only (`?noech` does one visit)                                                                                                                                        |
| `STOMP_SITE_POOL`         | `0`            | More ports to answer on, a list or a number of free ones to take: the slots of the site pool (see Site pool; `0` or `off` for none, `?nopool` on the page leaves it out for a visit)                                                                                                                                                                                      |
| `STOMP_DEFAULT_THEMES`    | Shooting Star  | Web Store ids, comma separated, of the themes a new profile has installed and not shown (docs/themes.md, The default theme); `0` for none, which the test suites use                                                                                                                                                                                                      |
| `STOMP_TEST_TRANSPORT`    | unset          | Set to `1` to use `/test/mixed-transport.mjs` (epoxy that reaches the suites' fixture hosts: mixed-content's, and the names under a private suffix); test runs only                                                                                                                                                                                                       |

They can also live in a `.env` file next to `package.json` (not committed);
the server reads it at startup. The page gets what it needs from `/config.js`.

## Tor routing

The homepage has a **Tor** checkbox beside **Block ads**. It is enabled only
when a Tor-backed Wisp relay is configured. The choice is kept in
`localStorage['stomp-demo:tor']` (or set for one visit with `?tor` / `?notor`),
independently of the content blocker. Changing it reloads the page, since
`controller.setTransport()` allows requests already using the old transport
to finish. Tor uses a separate `/stomp-tor/` service worker scope, and the
STomp HTTP cache is disabled. The persistent cookie, storage and extension
databases of the proxy origin are **still shared** with normal mode; this
route is not an isolated browsing profile. HTTP/3, UDP, WebTransport and the external ECH
DNS lookup are off. A missing Tor relay stops Tor-mode browsing rather than
trying the normal Wisp endpoint.

Run a Tor SOCKS5 listener on the demo server, then start the demo with:

```sh
STOMP_TOR_SOCKS5=socks5h://127.0.0.1:9050 npm run demo
```

The server starts a second holyWisp endpoint at `/wisp-tor/`, upstream of
which is Tor's SOCKS5 listener. Names are sent to SOCKS5 for Tor to resolve,
including `.onion` names. The helper resolver gives holyWisp a public
placeholder address for its initial address-class check, without asking the
machine's usual resolver; the original hostname is sent in the SOCKS5
CONNECT. UDP is refused, not sent directly. The Tor listener must be on
loopback. If no listener is available at startup, the relay is not offered.

Alternatively `STOMP_TOR_WISP_URL=wss://relay.example/wisp/` names a separately
operated Tor-backed Wisp relay. Configure **one** of these on the server.
The external relay must resolve names inside Tor, route every outbound TCP
connection through Tor and reject all UDP. A page cannot prove that an
untrusted relay obeys these rules. On HTTPS pages the Tor endpoint must use
`wss://`; an unencrypted `ws://` endpoint is accepted only for local testing.

**Scope:** this provides Tor egress for sites opened through STomp's TCP
transport (HTTP(S), WebSockets and `.onion`), with no direct fallback in Tor
mode. It does **not** turn the browser into Tor Browser. The application shell,
GitHub commits/avatars and other requests the host makes directly do not
pass through the Tor relay. The relay operator can see the user's network
address and requested destinations; websites see the Tor exit, but shared
cookies, logins and browser fingerprints can still link sessions. Tor supports
TCP; features that require UDP cannot use this route. The relay must be
secured, rate-limited and monitored before it is offered publicly.

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
   (`debugTransport`), as About's Transport log row says.
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
   replaces its address then; a dialed tab (`?mode=just-call-stomp`) is never
   navigated, so each new entry of it is a `pushState`, and Back and Forward
   step the tab. A demo framed by its embedder (SystemYA's `/ui/`), or one
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

## Files

```
demo/
├── server.js           Express + holyWisp host
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
