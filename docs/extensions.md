# Chrome extensions

STomp runs Chrome extensions (MV2 and MV3) on the sites it proxies. Its
service worker keeps and serves them, injects their content scripts into
the documents it serves, and runs their webRequest and declarativeNetRequest
on the requests it sends on. The controller hosts what Chrome keeps in the
browser: backgrounds, the toolbar action's state per tab, popups and the
tabs. A host page manages them through `controller.extensions`, on
`StompController` and `RemoteController` alike.

## Using it

```js
const controller = new StompController({ ... });
await controller.wait();

// a .crx or .zip (ArrayBuffer, Blob, File), a Web Store id or URL, or an
// unpacked extension's files (a path map, or <input webkitdirectory>'s FileList)
const info = await controller.extensions.install(file);
const fromStore = await controller.extensions.install('cjpalhdlnbpafiamejdnhcphjbkeiagm');

controller.extensions.onChange((change) => render()); // installs, badges, ...

// the toolbar
for (const action of await controller.extensions.actions(controller.tabIdOf(frame)))
	drawButton(action); // title, iconUrl, badgeText, badgeColor, popupUrl, enabled
const popup = await controller.extensions.openPopup(info.id, { at: button });
popup?.onClose(() => {});

// pages
const options = await controller.extensions.options(info.id);
await frame.go(controller.extensions.resolveUrl(options.displayUrl));
```

| Member                                             | Description                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install(source, { filename, enabled, policy })`   | install, or update in place an extension of the same id; resolves to its `ExtensionInfo`. `policy: true` is an enterprise policy install: an MV3 extension may then block in webRequest.                                                                       |
| `list()`, `get(id)`                                | the installed extensions, oldest first; one, or null                                                                                                                                                                                                           |
| `enable(id)`, `disable(id)`, `remove(id)`          | a disabled extension's content scripts, rules, listeners and background stop; `remove` deletes its package, storage and state                                                                                                                                  |
| `update(id)`                                       | download a Web Store extension again                                                                                                                                                                                                                           |
| `onChange(listener)`                               | `installed`, `updated`, `removed`, `enabled`, `disabled`, `action` (a badge, title, icon or popup changed), `menus`, `notification`, `tab` (open `change.url` in a new tab: an extension opened one while the host has none), `ready`; returns the unsubscribe |
| `action(id, tabId?)`, `actions(tabId?)`            | the toolbar button of one extension, or of every enabled one with an action, for a tab (default: the active tab)                                                                                                                                               |
| `clickAction(id, tabId?)`                          | what a click does: `popup`, `clicked` (action.onClicked went to the background), or `disabled`                                                                                                                                                                 |
| `openPopup(id, { tabId, parent, at })`             | click and show the popup in a new iframe anchored at an element or a point; null when the click went to the background                                                                                                                                         |
| `mountPopup(id, iframe, tabId?)`                   | show the popup in an iframe of the host's; the `PopupHandle` tells its size (`onResize`, clamped as Chrome clamps popups) and `onClose` (the popup's `window.close()`)                                                                                         |
| `options(id)`                                      | the options page: `url`, `displayUrl` (`chrome-extension://...`), `openInTab`                                                                                                                                                                                  |
| `displayUrl(url)`, `resolveUrl(url)`               | an extension URL as an address bar shows it, and back (`frame.go(resolveUrl('chrome-extension://<id>/page.html'))` opens an extension page in a tab)                                                                                                           |
| `extensionOf(url)`                                 | the extension a URL belongs to, or null                                                                                                                                                                                                                        |
| `menus(id)`, `clickMenu(id, info, tabId?)`         | an extension's context menu items, and telling it one was clicked                                                                                                                                                                                              |
| `notificationEvent(id, notificationId, kind, ...)` | tell it the user clicked or closed one of its notifications                                                                                                                                                                                                    |

`controller.tabIdOf(frame)` is the tab id the extensions know a frame by, and
`controller.activeTab` (a frame or null) is the tab `chrome.tabs.query({ active: true })`
answers; a host with tabs sets it as the user switches.

The demo (`demo/public/pm/main.js`, its "extensions" section) is a host
built on these calls: the bar's buttons with their badges, popups in a
popover through `mountPopup`, each extension's menu from `menus()`, an
Extensions page that installs from the Web Store, a file or a folder, and
`displayUrl`/`resolveUrl` in its address bar.

Every call rejects with an `ExtensionError` whose `code` says what went
wrong: `bad-source` (nothing installable was given), `bad-package` (not a
.crx or .zip STomp can read), `no-manifest`, `bad-manifest`, `webstore` (the
download failed), `not-found`, `no-popup`, `unsupported`, `disabled`.

## How it works

```
host page                        proxy origin                         service worker
controller.extensions  --RPC-->  ExtensionHub (with the controller)    ExtensionRegistry
                                  backgrounds: hidden proxied frames   packages, storage, state
                                  action state per tab, popups, tabs   content-script shells
                                        ^                              webRequest, DNR
                                        | BroadcastChannel per         extension origins
                                        | (controller, extension)
                       content scripts, extension pages, background
```

- **Packages.** The worker keeps each package as one blob in a Cache
  Storage cache of its own, with an index of where each file is in it
  (`src/server/extensions/store.ts`). An install is one put however many
  files the package has, and a file is inflated when something reads it.
  A removal deletes two caches.
- **Extension origins.** An extension's pages are served from its own
  emulated origin, `https://<id>.invalid`, through STomp's usual routes, so
  each extension gets its own partition of storage, cookies, caches and
  IndexedDB, as `chrome-extension://<id>` is its own origin. `displayUrl`
  writes it as `chrome-extension://`. The worker answers those URLs from the
  package (`serve.ts`), with web_accessible_resources enforced for any other
  origin's requests. There is no second service worker.
- **Content scripts.** When the worker serves a document that an enabled
  extension's `content_scripts` (or `scripting.registerContentScripts`, or
  `userScripts.register`) match, its shell gets a small part before the
  inject bundle: the runtime (`dist/extensionsRuntime.js`), its payload,
  and one `<script src>` per matching entry. A document no extension
  reaches gets none of it, and the inject bundle carries no extension code
  (only the runtime's file name, in the bundles' name table, 41 bytes). The
  runtime is served by its `init.assets` name, `extensionsRuntime`. Each
  entry's files are joined, rewritten once, wrapped as a function of its
  world's `chrome`, and kept in Cache Storage under a route that names the
  extension's generation, so every later document's load of it is a cache
  read with the browser's code cache.
- **When they run.** The runtime wraps `document.open` and `document.write`
  with functions shaped as the natives (the inject hooks over them in
  turn). The inject opens the document right before it writes the page's
  markup, in pieces that each end before a `</script`: document_start runs
  after the first piece made the root element and before any page script
  (Chrome's DidCreateDocumentElement point). document_end runs after the
  document's DOMContentLoaded listeners, document_idle a task later or at
  the window's load, whichever is first.
- **Worlds.** An ISOLATED script is a function of its `chrome`; the page
  never sees it. The worker rewrites `window.chrome`, `self.chrome` and
  `globalThis.chrome` in an isolated world's source to that `chrome`, and the
  runtime puts it on the window while the script's top level runs. MAIN
  scripts run as page code. USER_SCRIPT scripts (`userScripts.register`
  and `userScripts.execute`) get no `chrome` unless
  `userScripts.configureWorld({ messaging: true })`, and then one with
  `runtime.id`, `sendMessage` and `connect`, on the window too while they
  run.
- **Policies.** Content scripts load as script elements from routes, never
  through the page's `Function` or `eval`, so a page's CSP and Trusted Types
  do not refuse them (the browser enforces neither on proxied documents;
  the inject enforces them against the page's own code).
- **Extension pages and backgrounds.** A popup, options page or tab is a
  proxied document of the extension's origin; its window gets `chrome`. An
  MV2 background page and an MV3 service worker run in hidden frames of the
  controller's document. The service worker runs in a generated page in its
  script's folder, so what it resolves against its own URL (a relative
  `fetch`, `importScripts`) resolves as in a worker. Literal
  `importScripts` are loaded ahead as script elements; others are read with
  a synchronous request and run.
- **Networking.** An extension context's `fetch`, XHR and WebSocket are
  proxied requests like a site's, through the transport and the cookie jar.
  Cross-origin requests to hosts the extension has permissions for skip CORS
  (`registry.crossOriginAllowed`), as Chrome lets an extension's pages
  read them. `chrome.cookies` reads and writes STomp's jar, so a cookie it
  sets is the site's.
- **Calls into the worker.** `chrome.storage`, `scripting`, `cookies`,
  `declarativeNetRequest`, `permissions`, `management`, `userScripts` and
  webRequest's registrations are POSTs to `<directory>extapi`. The worker
  knows an extension page by its client's URL; a content document carries
  a token the worker made for it (an HMAC of the extension and client ids),
  and may only use `storage` (and `storage.session` when the extension
  opened it with `setAccessLevel`).
- **chrome.storage.** One IndexedDB record per key, so a set writes what it
  sets however much the area holds; its promise resolves once the
  transaction committed, and `onChanged` goes out after that, to every
  context of the extension under every controller of the scope.
- **Messaging.** `runtime.sendMessage`, `tabs.sendMessage` and ports go
  between an extension's contexts on a BroadcastChannel named for the
  controller and the extension, never through the host page or the worker.
  A message is serialized once, as JSON (Chrome's rule for messages), and
  read once in each receiving context. Contexts announce whether they
  listen, so "Receiving end does not exist" is told at once; a message to
  an extension whose background is not up yet wakes it first. Measured on
  Chrome 157 (the extensions suite): a sendMessage round trip from a
  content script to the service worker and a port round trip both take
  well under a millisecond on an idle machine.
- **The hub.** The controller's ExtensionHub starts and stops backgrounds,
  keeps the action's state per tab, the tabs (its controller's frames,
  `HubTabs`), offscreen documents, context menus and notifications, and
  answers the contexts' calls over the same channel. A RemoteController's
  hub is its controller frame's; the host page's frames are the tabs.
- **webRequest.** A background's listeners are registered with the worker,
  which asks them as requests pass (`pipeline.ts`): onBeforeRequest,
  onBeforeSendHeaders, onSendHeaders, onHeadersReceived, onResponseStarted,
  onBeforeRedirect, onCompleted, onErrorOccurred, with real headers and the
  tab and frame ids the hub knows. They may block (cancel, redirect,
  upgrade, request and response headers) for an MV2 extension with
  `webRequestBlocking`, or an MV3 one installed by policy, within 500 ms
  per request (`WEB_REQUEST_BUDGET_MS`); a listener that misses it once is
  dropped. Of several verdicts, a cancel wins, then the first redirect,
  then the last headers.

### declarativeNetRequest

The rules run in each controller's server's DnrHost (`src/server/dnr.ts`,
docs/extensions-dnr.md), Chrome's engine rebuilt in the worker. The
registry installs every enabled extension into it as the extension loads,
installs, is enabled again or updates: its `rule_resources` with each file's
text from the package, its DNR permissions, its host permissions and the
state the engine kept for it (dynamic rules, enabled rulesets), which the
registry stores with the extension's other state whenever the engine says
it changed. A disabled or removed extension's rules are uninstalled. Every
`chrome.declarativeNetRequest` call (rules, rulesets, `getMatchedRules`,
`testMatchOutcome`, `isRegexSupported`, `setExtensionActionOptions`) is
the engine's, with Chrome's answers and errors; with several controllers,
each engine makes the call, so they keep the same rules.

The worker asks the engine at the request's three points (before the
request, as its headers go out, as the response's arrive) and webRequest
after it, Chrome's order. A WebSocket or WebTransport handshake, which
never passes the worker, is asked about by the controller while any
extension is enabled. Tab ids come from the hubs: each top document's
client is placed in its tab as it reports its navigation, a frame's
requests are in its parent's tab, and a main frame's own request is in
the tab `frame.go()` sent it to (the hub tells the worker first). The
action count badge goes to the extension's action for that tab. A click on
an extension's button grants it activeTab for the tab until the tab's top
document changes, which getMatchedRules reads.

## Limits

- Backgrounds share the controller document's thread and heap; an MV3
  service worker is emulated in a page, not a worker.
- An isolated world shares the page's realm: its top-level declarations
  stay its own (each entry is a function), but globals and prototypes are
  the page's, and separate content_scripts entries do not share
  declarations. The page cannot see `chrome`.
- No content scripts in documents STomp does not inject (JSON, text and
  image viewer documents) or in about:blank frames
  (`match_about_blank`, `match_origin_as_fallback`).
- declarativeNetRequest gives a main frame's own request its tab when the
  host sent it (`frame.go()`) or a document of the tab started it; a
  navigation a tab starts in no other way (a link the page's own markup
  holds, a form) has tab id -1 until its document reports. A WebSocket's
  or WebTransport session's handshake is tab -1. With several controllers
  in one scope, a rule's action count goes to the same tab id under each.
- `scripting.executeScript({ files })` runs the files but answers no
  result (a `func` answers its return value, as in Chrome).
- A module a content script loads with `import()` runs as page code,
  without the extension's `chrome`.
- Namespaces STomp does not implement answer what their kind would: an
  empty list for `getFontList`, `getAll` or `query`, Chrome's defaults for
  `privacy.*` and `proxy.settings` (which `set` changes for the context),
  and nothing for the rest.
- Chrome's own pages (`chrome://`), the Web Store's install UI, native
  messaging, `debugger`, `tabCapture` and `desktopCapture` are not there.
  Namespaces the extension asks for that STomp does not implement are
  stubs whose calls resolve and whose events never fire.
