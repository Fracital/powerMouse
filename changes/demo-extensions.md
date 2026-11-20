### Demo and API

- The demo has Chrome's extensions UI, on `controller.extensions`. After
  the address box each enabled extension's button shows its icon (or its
  initial) and the badge its background set for the active tab. A click
  shows its popup under the button, sized as the popup's document asks; the
  popup's `window.close()`, a click outside and Escape close and unload it.
  A right click opens its menu: the extension's own action menu items,
  then Options, Manage extension and Remove. The puzzle piece after the
  buttons, and the menu's new Extensions item, list every enabled
  extension with its badge and its menu, and open the Extensions page. That
  page adds an extension from the Chrome Web Store (its page or its id), a
  .crx or .zip file, or an unpacked extension's folder. Each extension has a
  card with its version, where it came from and its permissions, and from
  the card a user turns it on or off, opens its options, updates it from
  the Web Store, or removes it after a confirmation. An options page, or a
  tab an extension opens, shows `chrome-extension://<id>/...` in the
  address bar, typing such an address opens that page, and an extension's
  own page has no Shields button. The bar sets `controller.activeTab` as
  tabs change, so `chrome.tabs.query({ active: true })` answers the tab on
  screen. A phone's bar has no room for the buttons: at 390 px the puzzle
  piece lists them, and at 320 px the menu's item does, with the address
  box still 120 px wide. The demo-extensions suite checks all of this in
  the isolated host at 1280, 390 and 320 px, and the button and its popup
  in the same-origin host.
