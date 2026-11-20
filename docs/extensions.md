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
| `onPrompt(handler)`                                | draw the Chrome Web Store's install and uninstall dialogs: the handler gets `{ kind, id, name, iconUrl, permissions, url, frame }` and resolves true for Add extension or Remove (see below)                                                                   |
| `theme()`, `themes()`, `onTheme(listener)`         | the Chrome theme shown (null for the default), every installed theme, and hearing it change: see [Themes](#themes)                                                                                                                                             |
| `resetTheme()`                                     | Chrome's Reset to default: uninstall every theme                                                                                                                                                                                                               |

`controller.tabIdOf(frame)` is the tab id the extensions know a frame by, and
`controller.activeTab` (a frame or null) is the tab `chrome.tabs.query({ active: true })`
answers; a host with tabs sets it as the user switches. The extensions'
`tabs.onCreated`, `onActivated`, `onHighlighted` and `onRemoved` follow
`controller.frames` and `controller.activeTab`: push a frame (or call
`createFrame`) and put its element in the page to open a tab, splice it out
to close one.

The demo (`demo/public/pm/main.js`, its "extensions" section) is a host
built on these calls: the bar's buttons with their badges, popups in a
popover through `mountPopup`, each extension's menu from `menus()`, an
Extensions page that installs from the Web Store, a file or a folder,
`displayUrl`/`resolveUrl` in its address bar, and the store's dialogs
through `onPrompt`.

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
- **What the extension reads of its origin.** The emulated origin stays
  STomp's own: the extension sees `chrome-extension://<id>` wherever Chrome
  shows it (measured, 157). `runtime.getURL` answers it, as Chrome makes
  the URL (one leading slash dropped, dot segments resolved, the query and
  fragment kept), and so do a message sender's `url` and `origin`, a tab's
  `url`, `pendingUrl` and `favIconUrl`, webNavigation's and `tabs.onUpdated`'s
  URLs, `getPopup`, `getContexts`, management's `optionsUrl` and the
  initiator webRequest and declarativeNetRequest see for an extension's
  requests (an extension's own pages need no host permission for
  themselves there). A `chrome-extension://` URL a page or an extension
  writes loads from the emulated origin wherever it goes: an element, a
  fetch, a navigation, a frame (`src/StompURL.ts`), and the page's CSP lets
  it through. An extension document's origin, as `self.origin` reads it,
  as its messages carry it and as a message to it names it, is
  `chrome-extension://<id>`, in a page's realm too. In the extension's own
  pages the runtime puts a stand-in over the inject's `location`, and
  `document.URL`, `documentURI`, `baseURI`, `domain`, the URLs read back
  of elements, responses and requests, a link's `origin`, `protocol`,
  `host` and `hostname`, and the `blob:` URLs the page makes
  (`blob:chrome-extension://<id>/...`, which load as the inject's own) show
  `chrome-extension://`; an emulated service worker's `location` is its
  script's, as a WorkerLocation reads (`src/extensions/runtime/present.ts`).
  What the runtime defines in a page reads as native, its source included:
  the inject hands the runtime its own toString table as it loads
  (`src/inject/modules/Proxy.ts`, `natives.ts` masking).
- **Content scripts.** When the worker serves a document that an enabled
  extension's `content_scripts` (or `scripting.registerContentScripts`, or
  `userScripts.register`) match, its shell gets a small part before the
  inject bundle: the runtime (`dist/extensionsRuntime.js`), its payload,
  and one `<script src>` per matching entry. A document no extension
  reaches gets none of it, and the inject bundle carries no extension code
  (only the runtime's file name, in the bundles' name table, 41 bytes). The
  runtime is served by its `init.assets` name, `extensionsRuntime`. Each
  entry's files are joined once: an ISOLATED entry's as the source its
  world evaluates (Isolated worlds, below), a MAIN or USER_SCRIPT entry's
  rewritten as page code and wrapped as a function of its `chrome`. Either
  is kept in Cache Storage under a route that names the extension's
  generation, so every later document's load of it is a cache read.
- **When they run.** The runtime wraps `document.open` and `document.write`
  with functions shaped as the natives (the inject hooks over them in
  turn). The inject opens the document right before it writes the page's
  markup, in pieces that each end before a `</script`: document_start runs
  after the first piece made the root element and before any page script
  (Chrome's DidCreateDocumentElement point). document_end runs after the
  document's DOMContentLoaded listeners, document_idle a task later or at
  the window's load, whichever is first.
- **Worlds.** ISOLATED scripts run in an isolated world of their
  extension's (below). MAIN scripts run as page code. USER_SCRIPT scripts (`userScripts.register`
  and `userScripts.execute`) get no `chrome` unless
  `userScripts.configureWorld({ messaging: true })`, and then Chrome's:
  the page's `csi` and `loadTimes`, and a `runtime` of `id`, `dynamicId`,
  `sendMessage`, `connect`, `onMessage`, `onConnect` and the runtime's
  enums, on the window too while they run.
- **Policies.** Content scripts load as script elements from routes, never
  through the page's `Function` or `eval`, so a page's CSP and Trusted Types
  do not refuse them (an isolated world's writes are exempt too, below) (the browser enforces neither on proxied documents;
  the inject enforces them against the page's own code). An extension's
  own resources (its web accessible scripts, styles and images) load past
  the page's CSP, as Chrome lets `chrome-extension:` URLs past it;
  `frame-ancestors` still holds. The worker tells the extension's origin
  which origin asked for a file (`EXTENSION_INITIATOR`), so
  web_accessible_resources' `matches` judge it when the page's referrer
  policy sends no Referer. In a sandboxed frame without
  `allow-scripts`, scripts that `executeScript` injects carry the nonce of
  STomp's sandbox policy, so they run there as they do in Chrome.
- **Text documents.** A JSON or text document (`application/json`, `+json`
  types, `text/plain` and the other text types Chrome renders) that an
  extension's content scripts match is served as the HTML Chrome makes of
  it: the text in a `<pre>`, with Chrome's head, and `document.contentType`
  reads the original type. A document no extension matches is passed
  through untouched.
- **Localized manifest.** `runtime.getManifest()` answers the manifest as
  Chrome localizes it: `name`, `short_name`, `description`, the action's
  `default_title`, commands' descriptions and the omnibox keyword, with
  `current_locale`. As in Chrome, `__MSG_` placeholders in an extension
  page's HTML are left as they are.
- **Extension pages and backgrounds.** A popup, options page or tab is a
  proxied document of the extension's origin; its window gets `chrome`. An
  MV2 background page and an MV3 service worker run in hidden frames of the
  controller's document. The service worker runs in a generated page in its
  script's folder, so what it resolves against its own URL (a relative
  `fetch`, `importScripts`) resolves as in a worker. Literal
  `importScripts` are loaded ahead as script elements; others are read with
  a synchronous request and run. The folder is the script's path as Chrome
  resolves it from the root, so SponsorBlock's `./js/background.js` runs
  in `js/`.
- **Service worker.** The page an MV3 worker runs in gets what a
  ServiceWorkerGlobalScope has: the `install`, `activate`, `fetch` and
  `message` events with their handler attributes and classes
  (`ExtendableEvent`, `FetchEvent`, `ExtendableMessageEvent`, `Client`,
  `WindowClient`), `clients`, `registration` and `serviceWorker`
  (`src/extensions/runtime/serviceWorker.ts`). Once its script ran, it gets
  `install`, then `activate`, each awaited through `waitUntil`. The
  worker controls the extension's pages, as Chrome's does: each one's
  `navigator.serviceWorker` has the worker as its `controller` and
  `ready.active`, and messages go both ways over the extension's channel,
  cloned as postMessage clones them, with a `WindowClient` for the page as
  the source. A worker that listens for `fetch` when its script ran tells
  STomp's worker so (`src/server/extensions/fetchEvents.ts`), which then
  posts it the requests Chrome would give it, before the HTTP cache:
  navigations to the extension's pages, a web page's frame of one
  included, and every load of those pages and their workers; never a web
  page's own request for a web_accessible_resource (a content script's
  included), the generated background pages' or the worker's own
  (measured, 157). It says within 5 s whether it took the request; one it
  did not take goes on to the package, and its response, a network error
  included, is the page's as the origin's would be. Violentmonkey's popup
  and options pages get their data this way (`/get-data.js`).
- **Networking.** An extension context's `fetch`, XHR and WebSocket are
  proxied requests like a site's, through the transport and the cookie jar.
  Cross-origin requests to hosts the extension has permissions for skip CORS
  (`registry.crossOriginAllowed`), as Chrome lets an extension's pages
  read them. `chrome.cookies` reads and writes STomp's jar, so a cookie it
  sets is the site's.
- **Calls into the worker.** `chrome.storage`, `scripting`, `cookies`,
  `declarativeNetRequest`, `permissions`, `management`, `userScripts`,
  webRequest's registrations and a service worker's fetch handler are POSTs
  to `<directory>extapi`. The worker
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
- **Popups.** A popup is sized as Chrome sizes one: its root's min-content
  width and its height at that width, plus a scrollbar across a side the
  800 by 600 bound cuts, measured again on every change to its document,
  its body's size, its load and its fonts, then clamped to 25 by 25 up to
  800 by 600.
- **The hub.** The controller's ExtensionHub starts and stops backgrounds,
  keeps the action's state per tab, the tabs (its controller's frames,
  `HubTabs`), offscreen documents, context menus and notifications, and
  answers the contexts' calls over the same channel. A RemoteController's
  hub is its controller frame's; the host page's frames are the tabs.
- **Tabs' and webNavigation's events.** The host page watches its frames
  (`framesAsTabs`): a frame that appears, is shown or goes away, each top
  document's first report (its commit), its URL moving within the
  document, its title and icon, and the frame element's load. The hub
  turns those into `tabs.onCreated`, `onUpdated` (status, URL, title,
  `favIconUrl`), `onActivated`, `onHighlighted` and `onRemoved`, and for an
  extension with `webNavigation` into `onBeforeNavigate`, `onCommitted`,
  `onDOMContentLoaded`, `onCompleted`, `onHistoryStateUpdated` and
  `onReferenceFragmentUpdated`, in Chrome's order, with the tab ids the hub
  knows and a `documentId` per document. A frame below a tab's top is told
  by the extension's content scripts in it: its commit when they say
  hello, its DOMContentLoaded and load from there. Listeners' URL filters
  are applied as Chrome applies them. `webNavigation.getFrame` and
  `getAllFrames` answer the tab's top and the frames the extensions'
  content scripts reached.
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

### Isolated worlds

In Chrome an ISOLATED content script shares the page's DOM and nothing
else: its globals, prototypes and expandos are its own, and the page's CSP
and Trusted Types do not apply to it. STomp makes the same world per
extension and document, the first time one of the extension's ISOLATED
scripts or injections runs there (`src/extensions/runtime/worlds.ts`).

The runtime appends a hidden element to the root, makes an about:blank
frame in its closed shadow root, evaluates the world's bundle in the
frame's realm and removes the element again, in one synchronous run with
the inject's own mutations hidden. The page never sees the frame:
`window.length` and `frames` stay as they were, and no observer record,
load event or global of it reaches the page. The realm keeps its
JavaScript (`Object`, `Array`, `Promise`, `eval`) after the frame is gone,
and that is the world's.

The world reaches the page's DOM through proxies
(`src/extensions/runtime/world/membrane.ts`). A DOM object is seen with
the page's interfaces as the runtime found them at document_start, before
any page or MAIN script ran, so a page's `Document.prototype.styleSheets`
or `addEventListener` override is not what the world calls, and the page's
expandos on elements are not there. What crosses back (event details,
message data, a promise's value) is copied into the world's own objects,
so `detail instanceof Object` holds. The world's own functions are handed
to the page as functions of the page's realm, because the browser runs no
callback of a realm whose frame is gone. One the page reads back (a handler
property the world set) has the world's function's name and length and
reads as native code, by the inject's `toString`.

Every web name of the world's window (`fetch`, `setTimeout`, `Element`,
`innerWidth`) is the page's through the membrane from its first use; names
the world sets stay its own, and the page's are none of its. A script runs
as global code, so its `var` and function declarations are seen by the
extension's other scripts in the document, as in Chrome.

Markup and script URLs the world writes into the page's Trusted Types
sinks go through a policy of the world's, and the inject's CSP checks are
not applied to the world's code, so a page's `require-trusted-types-for
'script'` refuses only the page's own writes.

A content script's `import()` resolves in the world: the worker turns the
extension's module (and what it imports) into a description the world
links and runs, with the world's `chrome` and its `chrome-extension://`
URL as `import.meta.url`. As in Chrome, a module must be in
web_accessible_resources for the page's origin. The worker takes that
origin from the request's client (the document that asked), never from
the request, and refuses a request whose client it cannot name, so a page
reads no module it could not fetch itself.

The runtime grew by the world's bundle (about 62 kB of
`dist/extensionsRuntime.js`), which only documents an extension reaches
load. Taking the page's interfaces at document_start takes about 3 to 4 ms
per document (20 ms cold) and is done only when an extension has ISOLATED
scripts there or `scripting`, `tabs` or `activeTab`. The inject bundle
grows only by the call that hands the runtime its way to hide mutations
(24 bytes).

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

The worker asks the engine at the request's three points: before the
request, as its headers go out, and as the response's arrive. Before the
request, webRequest's onBeforeRequest goes to the listeners first and the
engine matches while they answer, as Chrome's
`WebRequestEventRouter::OnBeforeRequest` does. A request a rule blocks or
redirects is still told to the listeners (onBeforeRequest, then
onErrorOccurred with `net::ERR_BLOCKED_BY_CLIENT`), and their blocking
answers are dropped. As the response's headers arrive, onHeadersReceived
also goes first. As the headers go out, onBeforeSendHeaders sees them as
they were before the engine's changes, and its answer is merged as
Chrome's `MergeOnBeforeSendHeadersResponses` merges it: the rules' changes
stand, and a listener's change is dropped whole when it sets a header a
rule removed or set to another value, or removes one a rule set.
onSendHeaders sees what goes out. A WebSocket or WebTransport handshake, which
never passes the worker, is asked about by the controller while any
extension is enabled. Tab ids come from the hubs: each top document's
client is placed in its tab as it reports its navigation, a frame's
requests are in its parent's tab, and a main frame's own request is in
the tab `frame.go()` sent it to (the hub tells the worker first) or in the
tab of the document that started it, and its redirects stay in that tab. A
socket's handshake is in its document's tab and frame, and a dedicated
worker's requests and sockets in its page's. Frame ids are the worker's:
the hub asks it for a nested document's id, so a context's
`sender.frameId`, executeScript's results and the rules' matches agree. A
frame keeps its id across its documents, whether it navigated itself or
its parent set its src.
The action count badge goes to the extension's action for that tab. A click on
an extension's button grants it activeTab for the tab until the tab's top
document changes, which getMatchedRules reads.

### The Chrome Web Store

Open a listing at `https://chromewebstore.google.com` in powerMouse. If the
store offers **Add to Chrome**, click it and review the permissions in the
host's dialog. **Add extension** installs inside powerMouse, not in your
browser. **Cancel** downloads nothing. To uninstall, click **Remove from
Chrome** and confirm. The page may still recommend switching to Chrome;
STomp does not hide that notice or enable a button the store disabled.

The listing calls `chrome.webstorePrivate` and `chrome.management`.
STomp defines them in the store's documents, from the extensions' runtime
(`src/extensions/runtime/webstore.ts`): the worker ships the runtime to a
store page even with no extension installed. They are on the page's own
`chrome`, after `loadTimes`, `csi` and `app`, with `chrome.runtime` as a
web page has it (`connect`, `sendMessage`, the enums). As in Chrome's
bindings, every function has length 0 and reads as native, a call is
checked against its schema (`Error in invocation of
webstorePrivate.getExtensionStatus(string id, optional string manifest,
optional function callback): No matching signature.`), the last argument
may be a callback (with `chrome.runtime.lastError` set while it runs, and
`Unchecked runtime.lastError: ...` on the console when it is not read) or
the call returns a promise, and the enums have Chrome's sorted
SCREAMING_CASE keys. `management.onInstalled`, `onUninstalled`, `onEnabled`
and `onDisabled` follow the extensions' change channel in Chrome's order.

Each call goes to the worker on `<directory>extapi` with `store: true`
(`src/server/extensions/webstore.ts`). The worker looks up the calling
document's client, checks its real origin (including the port), and verifies
the grant it issued to that client when it served the navigation. A fetch
of the listing cannot obtain a grant for the fetching document.

- `beginInstallWithManifest3(details)` checks the id, resolves the icon URL,
  answers `already_installed` for an installed id or one being installed,
  parses the manifest, fetches and decodes the icon (`icon_error`, "Image
  decode failed"), and asks the host. Add extension answers `""` and keeps
  the approval; Cancel answers `user_cancelled`, "User cancelled install".
- `completeInstall(id)` takes the approval ("<id> does not match a previous
  call to beginInstallWithManifest3" without one). The registry downloads
  the CRX3 through the controller's transport and verifies the developer and
  Web Store publisher signatures. The signed id must be the listing's id,
  and the manifest must match the one the user approved. A raw ZIP is not
  a Web Store download. Installing a local file is a separate host action.
- `getExtensionStatus(id, manifest?)` answers `force_installed` (policy),
  `enabled`, `disabled`, `deprecated_manifest_version` (an MV2 manifest, as
  Chrome 157 installs none, unless it is a theme's) or `installable`.
- `management.getAll()` and `get(id)` answer Chrome's `ExtensionInfo`, its
  keys sorted as the bindings give them: `installType` `normal`,
  `development` or `admin`, the manifest's `update_url` as `updateUrl` (the
  update service's for a store install without one), the store's
  `homepageUrl` for a store install, `versionName` (`""` without
  `version_name`), `type` `theme` or `extension`, icons as
  `chrome://extension-icon/<id>/<size>/0`, permissions and hosts sorted.
- `management.uninstall(id, { showConfirmDialog: true })` asks the host and
  answers "Extension <id> uninstall canceled by user." on Cancel.
- `getMV2DeprecationStatus` answers `hard_disable`, `getReferrerChain` an
  empty chain (as with Safe Browsing off), `getBrowserLogin` no account, and
  `getFullChromeVersion` the browser's full version.

The dialogs are the host's: the worker sends `extensionPrompt` to the
controller, which hands it to `extensions.onPrompt` (the controller frame of
a `RemoteController` relays it to its host's page). The request carries the
name the store gave (75 characters at most), the icon as a data: URL and
Chrome's permission warnings (`src/extensions/permissionMessages.ts`, the
rules of `chrome_permission_message_rules.cc`, such as "Read and change
your data on 127.0.0.1 and chromewebstore.google.com"). The demo draws
`Add "<name>"?`, "It can:" and the warnings, with Add extension and Cancel
(`Remove "<name>"?` with Remove and Cancel), and its buttons take a click
only after 500 ms, as Chrome's do. After an install the store's
`onInstalled` fires and the page shows Remove from Chrome, and the bar gets
the extension's button from the same change.

No extension's content script or injection runs in the store's pages, and
no webRequest listener or rule sees a request for one: Chrome hides the
store from every extension, so none can press its buttons.

### Themes

A package whose manifest has a `theme` key is a theme, as Chrome reads it.
On a theme's listing, Add to Chrome installs it on the click: Chrome 157
shows no dialog for a theme (measured on the store's Themes category), so
the controller checks the click and the focus and asks the host nothing.
Most of the store's themes are Manifest V2, which Chrome still installs
for a theme: `getExtensionStatus` answers `installable` and
`beginInstallWithManifest3` takes them. The rest of the flow is an
extension's: `completeInstall` downloads and verifies the CRX3,
`onInstalled` fires with `type: "theme"`, the page shows Remove from Chrome,
and Remove from Chrome asks the host (`Remove "<name>"?`) as Chrome does.

Chrome runs nothing of a theme. The worker loads one from its manifest
without the keys an extension's code or grants come from (`background`,
`content_scripts`, `permissions`, `host_permissions`,
`declarative_net_request`, `web_accessible_resources`, pages, actions, and
the rest: `src/server/extensions/themes.ts` keeps the keys every package
has), and lists each one it left out in `ExtensionInfo.warnings`. A theme
has no permissions, no content scripts, no rules, no background and no
toolbar button; the hub skips it, the request path treats a scope with only
themes as one with no extension, and its origin serves its pictures and
`manifest.json` only (a navigation to one of its pages answers 404).
`chrome://extensions` lists no theme, and neither does the demo's
Extensions page.

One theme is shown at a time. A new theme turns off the one it replaced:
`getAll` lists the old one with `enabled: false`, `mayEnable: true` and
`disabledReason: "unknown"`, and its status is `disabled`. Chrome keeps it
for the undo of its install bubble until the tab that installed the new
theme navigates, then uninstalls it; the worker drops it once the store's
document that installed the new theme is gone (the next store call, list or
theme read finds out). A theme the host installs, or turns on with
`enable(id)`, replaces the shown one at once. `resetTheme()` is Chrome's
Reset to default: every theme is uninstalled and the store's pages hear
`onUninstalled`, as chrome://settings does it.

The host draws the theme. `extensions.onTheme(listener)` calls the listener
soon with the theme shown now (after a reload, the installed one) and then
with every change, null for the default. `theme()` reads it once and
`themes()` lists every installed theme, the shown one first. Each is a
`ThemeInfo`:

```js
controller.extensions.onTheme((theme) => {
	if (!theme) return useDefaultLook();
	// { id: 'chrome-theme:<extensionId>', extensionId, name, description,
	//   version, source: 'webstore' | 'package' | 'unpacked', enabled,
	//   theme: { colors, tints, properties, images } }
	applyChromeTheme(theme.theme);
});
```

`theme` is `manifest.theme` with Chrome's key names and values as the
manifest wrote them: `colors` (`frame: [r, g, b]`, `button_background:
[r, g, b, a]`, ...), `tints` (`buttons: [h, s, l]`, -1 for unchanged),
`properties` (`ntp_background_alignment`, `ntp_background_repeat`,
`ntp_logo_alternate`) and `images` (`theme_frame`, `theme_toolbar`,
`theme_ntp_background`, ...). STomp does not map them to colors of its own
or fill in Chromium's defaults; the host does. Each image is a blob: URL of
the host's page, made from the package's file; an image given per scale
(`{ "100_percent": ..., "200_percent": ... }`) is the same dictionary of
blob: URLs, and an image whose file the package does not have is left out,
as Chrome leaves it out. The URLs stay valid while the theme is installed.
The name and description are localized (`__MSG_*__`). A theme persists with
the extensions, in the worker's store, across reloads.

The demo hands the theme to its theme system: `showChromeTheme` in
`demo/public/pm/main.js` calls `PMTheme.fromChrome(theme.theme, theme)` and
`PMTheme.install` when the page has them.

## Limits

- Backgrounds share the controller document's thread and heap; an MV3
  service worker is emulated in a page, not a worker.
- The emulated origin still shows in one read: in a web page, an
  element's URL a content script set to `getURL()`'s reads back in the
  emulated form.
- An emulated service worker controls every page of its extension from
  the page's start (Chrome leaves a page that loaded before the worker
  was active uncontrolled until `clients.claim()`). Its messages carry no
  ports: a transfer list is cloned, not moved. With the scope open in two
  tabs, each tab's hub runs the worker's page, and a fetch event goes to
  whichever answers first.
- In an isolated world, top-level `let`, `const` and `class` declarations
  are not shared between scripts (`var` and functions are), and a
  script's `'use strict'` does not make it strict. Code made with
  `new Function` or an indirect `eval` runs in the world's realm but sees
  the gone frame's `document`, `location` and `top`. A named property of
  the window (an element's id) is not a global there.
- A document whose policy forbids `eval` (a sandboxed frame without
  `allow-scripts`, under STomp's sandbox policy) can make no world: its
  ISOLATED scripts run in the page's realm with the extension's `chrome`, as
  before isolated worlds, and see the page's globals and prototypes.
- No content scripts in documents STomp does not inject (image viewer
  documents) or in about:blank frames (`match_about_blank`,
  `match_origin_as_fallback`). A text document is served as UTF-8, so
  `document.characterSet` reads UTF-8 whatever the response's charset, and
  document_start runs after the first write, not with the body already
  there.
- webNavigation sees a frame below a tab's top only where the extension's
  content scripts run, gives such a frame `parentFrameId` 0 however deep
  it is, and tells its top document's DOMContentLoaded at the frame's load.
  A top document's `transitionType` is `typed` for a tab's first document,
  `reload` for the same URL again and `link` otherwise, with no
  qualifiers. A navigation that fails tells no `onErrorOccurred`.
  `onCreated` gives no `openerTabId`.
- A main frame's request that neither the host nor a hooked document
  announced (one that leaves an image document, or an about:blank one the
  page wrote) is matched with tab id -1, so a `tabIds` condition misses it
  and onRuleMatchedDebug reports -1. Its matched rules and its action
  count are held for its document, and go to the tab once that document
  reports, however many such navigations overlap. With several controllers
  in one scope, a rule's action count goes to the same tab id under each.
- A frame whose document announces nothing (an image) and whose parent
  sets its src before the parent's word reaches the worker: the
  navigation's own request, and the new document's requests before it
  reports, have a new frame id and the referring origin's latest document
  as parent. Once the document reports from the frame's window, it has
  the frame's id and parent.
- `scripting.executeScript({ files })` runs the files but answers no
  result (a `func` answers its return value, as in Chrome).
- Namespaces STomp does not implement answer what their kind would: an
  empty list for `getFontList`, `getAll` or `query`, Chrome's defaults for
  `privacy.*` and `proxy.settings` (which `set` changes for the context),
  and nothing for the rest.
- Store installs need transient user activation and focus in the requesting
  frame. Approvals belong to that document, last two minutes, and are lost
  if the worker restarts. Reload the listing to try again. The listing flow
  supports MV3 extensions, not themes, apps, or items the store flags for an
  additional safety check. A change to the listing's manifest requires a new
  approval, even if Chrome would allow the change without one.
- Chrome's own pages (`chrome://`), native messaging, `debugger`, `tabCapture` and `desktopCapture` are not there.
  Namespaces the extension asks for that STomp does not implement are
  stubs whose calls resolve and whose events never fire.
