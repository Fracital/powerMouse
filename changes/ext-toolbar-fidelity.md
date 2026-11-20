### Demo and API

- Extension buttons, popups and menus now behave as they do in Chrome 157.
  A new install with a button is pinned to the toolbar, and pins are kept in
  order. The button shows the action's 16 px icon (32 px on a 2x screen) or
  a letter tile, Chrome's badge, a grey icon when the action is off for the
  tab, and Chrome's tooltip with the site access line.
- The popup opens under its button in Chrome's square bubble, one at a
  time, sized from 25x25 to 800x600 as its page asks. It gets the focus once
  loaded. It closes on Escape, `window.close()`, a click outside, a second
  click on its button, another extension's button and a tab switch.
- `action.openPopup()` and `_execute_action` work, and so do other
  manifest shortcuts, even while a proxied page has the focus.
- The right-click menu lists Chrome's entries in Chrome's order: the
  name, the extension's own action items (six at most), site access,
  Options, Remove, Pin or Unpin, Manage extension, View web permissions,
  and Inspect popup in developer mode. Its look matches the main menu.
- The puzzle piece's list is Chrome's extensions menu, with sections by
  site access, a pin per row and More options.
- The main menu has submenus. Extensions is Chrome 157's: Manage
  extensions and Visit Chrome Web Store, and on a phone, where the bar has
  no room for the puzzle piece, the installed extensions as well. Themes
  lists the demo's themes with a check on the one shown, then Get themes
  and Reset to default. A submenu opens on a click, under the pointer or
  with the right arrow, and the left arrow or Escape closes it.
- Three new theme tokens: `ext-badge` and `ext-badge-text` (Chrome's
  default badge colours, dark or light) and `ext-highlight` (the circle
  behind a button whose scripts wait for a click).
- New `controller.extensions` calls: `pin`, `setSiteAccess`,
  `contextMenu`, `runMenuCommand`, `commands` and `runCommand`.
  `clickAction` can answer `granted`. `onChange` can report `settings` and
  `popup` (an `action.openPopup()` call to show).

### Fidelity

- `chrome.action.getPopup()` and `getTitle()` return the manifest's
  defaults. `getBadgeBackgroundColor()` returns `[0, 0, 0, 0]` until a color
  is set, as in Chrome. `setBadgeText()` refuses more than 100 bytes.
  `getUserSettings()` reports whether the button is pinned.
- Per-tab action state (badge, title, icon, popup) is cleared when the tab
  loads a new document, as in Chrome.
- A page action starts hidden.
- declarativeContent rules match page URLs and are kept across restarts.
- `contextMenus.onClicked` from an action menu gets Chrome's info and the
  full tab, and the click grants activeTab.
- `runtime.getViews()` and `getBackgroundPage()` return the extension's
  open pages.

### Known limitations

- The extension toolbar does not draw Chrome's 1 px gap around the badge.
  declarativeContent's `css` and `isBookmarked` conditions never match.
  "Inspect popup" opens the popup without developer tools. "View web
  permissions" opens the extension's card. The removal dialog has no
  "Report abuse" box.
