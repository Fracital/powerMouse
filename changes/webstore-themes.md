### Demo and API

- Click **Add to Chrome** on a theme's Chrome Web Store listing to install
  the theme in powerMouse, with no dialog, as Chrome does. A new theme
  replaces the last one, and **Remove from Chrome** asks before it
  uninstalls one. The store's page sees the states Chrome 157 gives it:
  Manifest V2 themes are installable, a replaced theme is disabled until
  the installing page goes away, and `management.getAll` answers a theme's
  `ExtensionInfo`. Nothing of a theme runs or is granted.
- `controller.extensions.onTheme(listener)`, `theme()`, `themes()` and
  `resetTheme()` give the host the theme shown: `manifest.theme`'s colors,
  tints, properties and images under Chrome's key names, each image a blob:
  URL of the host's page. The theme stays installed across reloads.
- `ExtensionInfo` has a `type` (`extension` or `theme`). The store's
  `ExtensionInfo` now always has `versionName`, takes `updateUrl` from the
  manifest, and lists its keys in Chrome's order.
