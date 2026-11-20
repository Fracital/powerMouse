### Demo and API

- The demo's Extensions page is now Chrome 157's chrome://extensions. It has
  a card per extension in Chrome's order (unpacked first, then by name),
  with its icon, name, description, Chrome's source badge, an on and off
  toggle, Details, Remove, and Reload for an unpacked extension. The search
  matches a name or an id. Developer mode adds each card's ID, version and
  Inspect views, an Errors or Warnings button, and a toolbar with Load
  unpacked, Pack extension and Update. The side nav holds My extensions,
  Keyboard shortcuts and a link to the Chrome Web Store, and folds behind a
  menu button on a phone. Adding from the store, a file or a folder works as
  before.
- An extension's details list Chrome's rows in Chrome's words: On or Off,
  the description, version, size, ID and inspectable views, its permissions,
  site access, Pin to toolbar, Collect errors, Extension options, Open
  extension website, View in Chrome Web Store, the source (with the folder an unpacked one was
  loaded from) and Remove extension. Site access is Chrome's choice of On
  click, On specific sites (with the Add a site dialog) and On all sites for
  an extension that asks for every site, and a toggle per site for one that
  asks for some. Manage extension and View web permissions in a button's
  menu open these details.
- The Errors view lists the manifest's warnings first, then what each
  context reported, with Chrome's levels, context and stack trace, Clear
  entry and Clear all. As in Chrome, errors are kept only in developer mode.
- Keyboard shortcuts lists every enabled extension's commands. A shortcut is
  typed into its field with Chrome's checks ("Include either Ctrl or Alt",
  "Use either Ctrl or Alt"), is kept across reloads, takes its key from any
  other command that had it, and can be cleared.
- Pack extension makes a CRX3 and its key from a folder, with Chrome's
  dialog and messages.
- Remove asks Chrome's question first. Turning an extension off stops its
  service worker, content scripts, declarativeNetRequest rules and button,
  and another extension hears `management.onDisabled`, `onEnabled` and
  `onUninstalled` as in Chrome.
- A theme gets no card, as in Chrome. A Theme row names it and links to
  the theme picker in Settings.
- The page lives in the new `demo/public/pm/extensions-page.js` and
  `extensions-page.css`.
- New `controller.extensions` calls behind the page: `setDeveloperMode`,
  `errors`, `clearErrors`, `setCollectErrors`, `setSiteHosts`,
  `setShortcut`, `setCommandScope`, `reload`, `pack` and `views`.
  `commands()` gives each command's stored shortcut and scope, and
  `_execute_action` for every extension with a button. `ExtensionInfo` adds
  `size`, `path`, `webStoreUrl`, `collectErrors`, `errorCount`,
  `permissionWarnings` and `allHostsRequested`.
- Errors are collected as Chrome's error console collects them: uncaught
  errors, rejections and `console.error` everywhere, `console.warn` except
  in a service worker, Chrome's manifest warnings, at most 100 per
  extension. An extension's uncaught errors no longer show in the host
  page's console.
- `reload()` restarts an extension with `runtime.onInstalled` reason
  `update`. Disabling or reloading invalidates its content scripts, as in
  Chrome.
