### Fixes

- An extension's toolbar icon no longer disappears once its background
  calls `chrome.action.setIcon({ path })`, and the extensions menu and the
  main menu's Extensions submenu no longer show it as a broken image. The
  path was handed to the host as a route of the extension's file, which
  answers only the extension's own contexts (ORB refused it on the
  isolated host, a 404 on the same-origin one); Tampermonkey sets a file
  it does not ship at every start, so its icon went right after install,
  after a reload and with every tab. setIcon now loads each path as
  Chrome's bindings do, decodes it and keeps the picture; a missing file
  fails the call with "Failed to set icon '<path>': Failed to fetch" and
  one that is no image with the decoder's words, leaving the icon as it
  was, as in Chrome 157. The manifest's toolbar icons are pictures
  whatever their size, and an icon the demo cannot decode is Chrome's
  placeholder letter. (demo-ext-icons suite.)
