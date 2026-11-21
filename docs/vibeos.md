# vibeOS in the demo

The demo can switch to [vibeOS](https://github.com/Fracital/vibeOS), a desktop
in the page, and back. Every open tab becomes a window of vibeOS's browser that
shows the tab itself: the same frame element with the same document, moved
there without a reload. Switching back puts the frames back as the demo's
tabs, just as alive. vibeOS is a git submodule at `vendor/vibeOS`; without it
the demo is built and runs as before and simply has no vibeOS switch.

## Getting it

A new clone with the submodule:

```sh
git clone --recurse-submodules https://github.com/Fracital/powerMouse.git
```

An existing clone:

```sh
git submodule update --init
```

Then install vibeOS's one runtime dependency (the tab strip, `chrome-tabs`)
and build as usual. vibeOS's own build tooling (Astro) is not needed:

```sh
npm ci --prefix vendor/vibeOS --omit=dev --ignore-scripts
npm run build
```

`node build.js` (which `npm run build` runs) builds vibeOS's desktop into
`dist/vibeos/` (`scripts/vibeos.mjs`) and says what it did in its log:

- `vibeOS: built dist/vibeos/ from <commit>`: the switch is there;
- `vibeOS: vendor/vibeOS is not checked out ...` or
  `vibeOS: its dependencies are not installed ...`: the build goes on
  without it, `dist/vibeos/` is not made and the demo has no switch.

A failed vibeOS build never fails the build either: it is logged and left out.
CI checks the repository out without submodules, so it builds and tests the
demo without vibeOS; the `demo-vibeos` suite says SKIP there.

`dist/vibeos/` holds the desktop's module and stylesheet (`embed.js`,
`embed.css`) and the files vibeOS serves on its own site (its icons, wallpapers,
games, cursors and fonts) next to them, about 14 MB. Not its emulator: v86
is fetched when it is used (The emulator, below). The npm package leaves it
out (`package.json` `files`). The server serves it from there and offers the
switch (`config.js` `vibeos`) only while `dist/vibeos/embed.js` exists; it
never reads `vendor/`.

## Its addresses

No address the browser keeps for a tab or a frame names vibeOS. The server
serves `dist/vibeos/` under a neutral directory, `/<8 hex>/`, minted the way
dialing's scopes are (docs/dialing.md): derived from the machine's name and
the checkout's path, the same at every start. `config.js` gives the page that
directory (`vibeos.base`) and, for each of vibeOS's own pages that a window
shows in a frame (its games, `dist/vibeos/appfiles/<name>/`), a neutral
directory of its own inside it (`vibeos.pages`): the Tetris window's frame is
at `/<8 hex>/<8 hex>/`, its files under that. The directory is known where
the bundle runs, not where it is built: vibeOS takes it from its module's
own URL (`__VIBEOS_EMBED__` in its `src/dom/types.ts`), and its stylesheet
names its files relative to itself.

What stays named is what is no frame's address: the module and stylesheet
(`embed.js`, `embed.css`), the icons, cursors, wallpapers and fonts, and a
game's own scripts and images, which a request shows (in the developer tools)
but no address bar does. The tabs are dialed as ever, so a tab's frame is
the call page. The vibeOS browser's Open in browser opens a page's own
address in a new browser tab, as asked.

To move vibeOS on: `git -C vendor/vibeOS fetch && git -C vendor/vibeOS checkout
<commit>`, rebuild, run `demo-vibeos`, and commit the new submodule commit.

## Using it

- The tab manager has a vibeOS button beside its new-tab button, and the menu
  has a vibeOS item (Leave vibeOS while the desktop shows). The desktop's
  panel has a powerMouse button that goes back.
- The switch is instant both ways. The tab in the middle of the tab manager
  (or the tab on screen) is the focused window; the tab manager's cards do not
  animate back to full screen on the way.
- Each tab is a vibeOS browser window. A new tab in that browser (its +,
  Ctrl+T, a link opened in a new tab, a page's `window.open`) is a demo tab;
  closing a window closes its tabs. Tabs that shared a window come back in it,
  where it was, on the next switch.
- The menu of vibeOS's browser (its gear) is the demo's own menu, the same
  element with the same items: Fullscreen, Extensions, Themes, Install
  powerMouse, vibeOS, Settings, About. The demo's menu is the one source of
  truth; vibeOS's standalone site keeps its own menu. Right-clicking a window's
  tab strip has Open in browser.

## Its font

vibeOS's font is its own: Open Sans (400, 600, 700) and Inconsolata, woff2
for latin and latin-ext as Fontsource packs them, under the SIL Open Font
License (each with its `OFL.txt`), in vibeOS's `public/fonts/` and copied to
`dist/vibeos/fonts/`. The page loads Open Sans with the module, before the
desktop shows, so it never shows in another font for a moment, and nothing
is fetched from another site (`demo-vibeos` checks both).

## Lazy loading

Nothing of vibeOS is fetched before the first switch: the page ships only the
button and the `vibeos` entry of `config.js`, which it fetches anyway. The first
switch imports `embed.js` from vibeOS's directory and its stylesheet and boots the desktop
(a brief load), then moves the tabs; every switch after that is instant and
fetches nothing. There is no prefetch: none is needed for the first switch to
keep the tabs live (they are moved only once the desktop is up), and a fetch at
idle would cost every visit for a feature few use. `demo-vibeos` checks that a
fresh page makes no request under vibeOS's directory until the switch is used.

## How the tabs move

Moving an element to another parent normally unloads an iframe's document.
`Element.prototype.moveBefore` (Chrome 133 and newer) moves it atomically and
keeps the document, its scripts, timers, scroll, focus, typed text and nested
frames alive. The demo hands vibeOS a host object (`vibeHost` in pm/main.js,
`BrowserHost` and `HostTab` in vibeOS's `src/dom/types.ts`); vibeOS's browser
moves each tab's live element into its window's panel with `moveBefore`, and
the demo moves it back into `#frames` the same way. A dialed tab swaps a fresh
frame in its element's place for each document (`element` event): the fresh
one is made beside the old one, so it is born in the window, and the demo moves
a frame still loading beside it back with it.

Where `moveBefore` is missing (a browser without atomic moves), nothing is
moved: the frames stay in `#frames` and vibeOS lays each over its window's
content box (`position: fixed`, followed on every animation frame), showing it only where
no window or menu above covers it. The documents are never re-created.

A minimized window is never `display: none`: it keeps its layout box, unseen
(`visibility: hidden`), out of hit testing and `inert`, so a tab's frame in
it keeps its scroll, its focused input and its selection, as a background
tab's does in the demo's own view; a frame laid over a minimized window is
inert too. The demo's universal `transition` stops at `#vibeos-root`, so a
window follows a drag at once and goes at once when minimized.

## The emulator

vibeOS's emulator (v86) is not in `dist/vibeos/` and the server never serves
it; nor is the libcurl relay vibeOS's own site streams its online disks
through. The first time an emulator opens, vibeOS fetches what that launch
needs from pinned sources, all on jsDelivr: v86 0.5.473's `libv86.js` and
`v86.wasm` as npm publishes them, the BIOS of the commit that release was
built from, and the disk images at a commit of vibeOS's own (copy.sh's
copies change under their names). It asks through the proxy, never from the
page: the page hands vibeOS its network (`vibeHost.fetch`, a request on the
controller's transport, the one its tabs use), and the
page itself makes no request to another site. Each file is used only when
its size and SHA-256 are the ones vibeOS pins (its `src/dom/v86files.ts`):
the core runs from a `blob:` URL, the wasm is instantiated from the checked
bytes, the BIOS and disks are handed over as buffers. Each is kept in Cache
Storage under its source's URL and checked again when read, so a later
launch is local and makes no request. The online systems stream their disks
from copy.sh through the proxy too. The guest's own network uses the page's
Wisp server, and has none in Tor mode. No frame is involved, so no address
changes. A remote controller (an isolated host) has no transport in the
page, and there the emulator says it cannot start.

## In offline.html

offline.html (`scripts/build-offline.mjs`, run from `file:` with no server)
has vibeOS too when the build has `dist/vibeos/`, with the same switch,
the same windows and the same `moveBefore` of each tab's frame. What the
server serves from vibeOS's directory is inside the file
(`scripts/offline-vibeos.mjs`): one gzipped archive, as base64 in a
`<script type="application/octet-stream" id="pm-vibeos">` at the end of the
body, which the browser parses as text and no script reads until the first
switch. Then `demo/offline/vibeos.mjs` unpacks it, makes a `blob:` URL of
each file and drops the element's text; `STOMP_OFFLINE.vibeos` hands the
page the module's and the stylesheet's URLs and a resolver for the rest
(`vibeHost.assets`, vibeOS's `BrowserHost.assets`): each root-relative path
vibeOS asks for is its file's `blob:` URL, and one the file does not carry
is `data:,`, so nothing is ever asked of `file:`. The stylesheet's `url()`s
(icons, cursors, fonts) are written as the files' URLs when it is unpacked.

The archive carries embed.js, embed.css and only the files they name: the
Tango icons, cursors, wallpapers, fonts and bookmark icons the code and the
stylesheet name, and the three games. No emulator (vibeOS fetches it through
the proxy as on the served demo, and keeps it in the page's Cache Storage,
which `file:` has in Chrome), no source maps, none of the legacy formats
Chrome never loads (a game's `.eot` and SVG fonts and Flash files, iOS's
home screen images), and not the 4 MB Garden Tiles wallpaper, more than the
rest together (its tile in the Wallpaper Picker is empty there). It is about
3.8 MB of files, 4.4 MB as gzipped base64, and offline.html goes from about
10.8 MiB to 15.2 MiB.

A game opens in its window from a `blob:` URL, but a document at a `blob:`
URL of the file's page may load none of the page's other `blob:` URLs
(Chrome refuses them as local resources), so each game's page is one text:
every file it, its styles and its scripts name is a `data:` URL in it,
written at build time. A name left as it was (an `.eot` font, a Flash
movie) resolves against no `blob:` URL and is never asked of anything.
The file's notices end with vibeOS's own: its licence, its bundled
libraries', its fonts', the Tango icons' and its games'.

## Deploying

The deploy gate (`deploy/terp-deploy-gate.sh`) builds in a stage checkout and
copies `dist/` to the live checkout. For vibeOS to be live it needs, in the
stage, after the checkout and clean: the submodule (`git submodule update
--init --depth 1`), its dependency (`npm ci --prefix vendor/vibeOS --omit=dev
--ignore-scripts`), then the usual build, which makes `dist/vibeos/`. The live
checkout never needs `vendor/vibeOS`.

## Checks

- `npm test -- demo-vibeos`: lazy loading, the switch both ways, the state
  of a tab (its script's state, a typed input, its scroll, a running timer and
  a nested frame's timer, no second request for either document), dialed
  tabs, new tabs, the menu, a minimized window, the neutral addresses, the
  font, the fallback without `moveBefore`, and the emulator: none in
  `dist/vibeos/`, a tampered core never run, a boot from Cache Storage with
  no request and, with the network (no `SKIP_NETWORK`), a fresh page's
  fetch of the pinned files through the proxy.
- `npm test -- offline-vibeos`: offline.html from `file:` (skipped when it
  has no vibeOS): the archive unread until the switch, no emulator in it,
  the switch from the menu with the tab's frame moved into its window and
  its state kept, the desktop's own `blob:` files with every image loaded,
  Tetris, 2048 and Breakout from `blob:` URLs with their files, the
  emulator booting from Cache Storage with nothing fetched, the way back,
  and no request from the switch on to the network or to `file:`.
- vibeOS's own checks, in `vendor/vibeOS` (they need its devDependencies):
  `npm run check`, `npm run build`.
