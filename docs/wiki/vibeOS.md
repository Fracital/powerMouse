<!-- Draft of the wiki page "vibeOS" (https://github.com/Fracital/powerMouse/wiki/vibeOS).
     GitHub wiki pages are Markdown files named by their title; publish this
     file as vibeOS.md in the wiki repository, without this comment. -->

# vibeOS

The STomp demo (https://stomp.fracit.al) can switch to
[vibeOS](https://github.com/Fracital/vibeOS), a desktop that runs in the page.
Every tab you have open becomes a window of vibeOS's web browser, instantly and
without reloading: the page keeps everything, its scroll, what you typed, a
video or a game in progress. Switch back and the windows are tabs again.

## Switching

- Open the tab manager (the Tabs button) and press the desktop button beside
  **+**, or choose **vibeOS** in the menu.
- In vibeOS, the **powerMouse** button on the panel, or **Leave vibeOS** in
  the browser's menu, goes back.
- The tab shown in the middle of the tab manager opens as the front window.
- New tabs you open in vibeOS's browser are ordinary tabs of the demo: they
  are there when you switch back. Closing a window closes its tabs.
- The browser's menu in vibeOS is the demo's menu: Fullscreen, Extensions,
  Themes, Install, vibeOS, Settings and About work the same in both.
- The first switch loads vibeOS (a moment); later switches are instant. The
  demo downloads nothing of vibeOS until you use it.
- Like a tab's address, a vibeOS window's address says nothing: a game's
  window has a neutral one, which names neither vibeOS nor the game.

## Building the demo with vibeOS

vibeOS is a git submodule of powerMouse at `vendor/vibeOS`. Clone with it:

```sh
git clone --recurse-submodules https://github.com/Fracital/powerMouse.git
cd powerMouse
npm install
npm ci --prefix vendor/vibeOS --omit=dev --ignore-scripts
npm run build
npm run demo
```

In a clone you already have:

```sh
git submodule update --init
npm ci --prefix vendor/vibeOS --omit=dev --ignore-scripts
npm run build
```

Without the submodule everything still builds and runs; the demo just has no
vibeOS button. The build log says which it did:

```
vibeOS: built dist/vibeos/ from <commit>
vibeOS: vendor/vibeOS is not checked out (git submodule update --init), the demo is built without the vibeOS switch
```

## Browsers

Tabs move into windows with `Element.prototype.moveBefore`, which keeps a
frame's page alive (Chrome and Edge 133 or newer). In a browser without it the
pages stay where they are and are drawn over their windows instead; nothing
reloads either way.

More detail, for developers: `docs/vibeos.md` in the repository.
