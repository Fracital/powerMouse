### Demo and API

- The demo's UI draws no browser focus ring on any element, for a click or
  a key: the toolbar, the omnibox, menus, popovers, dialogs, the settings,
  Extensions and Shields pages, the home page, the tabs, the bookmarks and
  the frame that holds a tab's page. As in Chrome's own UI, the keyboard's
  focus draws a 2px ring of the theme's that follows the control's corners
  (`--pm-focus` on the bar and the home page, the panels' accent in a
  popover or the settings dialog, a site sheet's own colour), and a click
  draws nothing. Before, the toolbar's buttons showed no focus at all from
  the keyboard (the menu buttons only a fill), a click in a text field of
  the settings or Extensions page drew a ring, and each control set its
  own ring colour. A text field shows its focus with its border. In forced
  colours the browser's own ring is back. Proxied pages keep Chrome's
  native rings: nothing changes in them. (demo-themes suite.)
