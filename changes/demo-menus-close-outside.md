### Demo and API

- The demo's menus and popups open one at a time and close wherever the
  press outside them lands, as Chrome 157's do. A right click on an
  extension's button opens its menu while the extensions list, the main
  menu or its popup is open. Before, the open popover's scrim took the
  press, the browser's own menu showed and nothing closed. In the
  extensions list, More options' menu closes on a press in the list and
  the list stays. Before, the list sat over the menu's scrim, so the menu
  stayed open and Manage extensions opened the Extensions page with the
  menu still showing under it. Each popover in front of another now has
  its scrim over it. A right click outside closes a menu. So do Escape,
  the window losing the focus or going hidden, another tab and a settings
  page opening. A menu or popup that opens over the Extensions page (an
  extension's shortcut) is in front of it and closes before it on
  Escape. A right click on an extension in the main menu's Extensions
  submenu opens its menu. On a phone, a press beside the Extensions
  page's side nav closes the drawer. (demo-extensions, demo-menu and
  extension-manager suites.)
