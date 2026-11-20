### Demo and API

- A new powerMouse profile has the Chrome Web Store theme Shooting Star
  (pink) installed and not shown. It is downloaded from the store's update
  service once the page is idle after boot, installed turned off, and
  listed in the Themes submenu and the theme picker with Default still
  chosen. Like Chrome's default apps it is offered once: a user who
  removes it does not get it back. `STOMP_DEFAULT_THEMES` names other
  themes, or `0` for none. `PMTheme.install(theme, { show: false })` keeps
  a theme without switching to it, and a Web Store theme the worker
  uninstalls now leaves the theme system too.
- The menu's Themes > Reset to default is on only while a theme other than
  Default is shown. It shows Default and uninstalls the theme shown when
  that is a Web Store theme, and leaves installed themes that are not shown
  alone; it no longer uninstalls every theme (webstore-themes suite).
