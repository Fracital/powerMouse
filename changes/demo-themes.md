### Demo and API

- The demo has themes, chosen in the menu's new Settings: Default (the
  powerMouse look as it was, pixel for pixel), Light, Dark, and Follow
  system, which takes Light or Dark from `prefers-color-scheme` and follows
  a change while the page is open. Every colour and background of the UI
  is a `--pm-` token in `pm/main.css`: the bars, the address box and its
  suggestions, the menus and popovers, the settings pages, the home page,
  the bookmarks, the tab manager, the request viewer, the dialogs and the
  extension and Web Store UI. The new `pm/theme.js` puts the saved choice
  on the page before its first frame, so a reload never shows another
  theme first. `globalThis.PMTheme` (`apply`, `list`, `current`,
  `install`, `remove`, `fromChrome`, a `change` event) is how the picker
  and an installed Chrome Web Store theme reach it. `fromChrome` maps a
  theme manifest's colours, tints, properties and pictures as Chromium
  does, deriving a missing colour by Chromium's rules. An installed theme
  is listed in the picker with Remove, and its pictures are kept in
  IndexedDB. docs/themes.md has the tokens and the mapping. (demo-themes
  suite.)
