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
games, cursors, the v86 emulator) next to them. The npm package leaves it
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
  tabs, new tabs, the menu, and the fallback without `moveBefore`.
- vibeOS's own checks, in `vendor/vibeOS` (they need its devDependencies):
  `npm run check`, `npm run build`.
