### Demo and API

- The demo can switch to vibeOS (Fracital/vibeOS, a git submodule at
  `vendor/vibeOS`) from the tab manager's desktop button or the menu's vibeOS
  item, and back from vibeOS's panel. Every tab becomes a window of vibeOS's
  browser holding the tab's own frame, moved with `moveBefore` so nothing
  reloads either way (laid over its window where `moveBefore` is missing); new
  tabs of that browser are the demo's tabs and its menu is the demo's menu.
  Nothing of vibeOS loads before the first switch. Without the submodule the
  build goes on, says so, and the demo has no switch (docs/vibeos.md,
  `demo-vibeos`).
- vibeOS is served under a neutral directory minted as dialing's scopes are
  (`config.js` `vibeos.base`), and each of its games under a neutral one
  inside it (`vibeos.pages`), so no frame's address names vibeOS or the game;
  the bundle finds its directory where it runs.
- vibeOS shows in its own font, Open Sans, served from its directory with its
  licence (vibeOS no longer asks Google Fonts for it) and loaded before the
  desktop shows.

### Build

- `node build.js` builds vibeOS's desktop and files into `dist/vibeos/` when
  `vendor/vibeOS` is checked out with its dependency installed, and logs that
  it left it out otherwise; the npm package leaves `dist/vibeos/` out.
