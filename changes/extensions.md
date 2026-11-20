### Demo and API

- STomp runs Chrome extensions, MV2 and MV3, on the sites it proxies
  (docs/extensions.md). `controller.extensions`, on `StompController` and
  `RemoteController`, installs them from a .crx or .zip (bytes, a Blob or a
  File), a Chrome Web Store id or URL, or an unpacked extension's files,
  and lists, enables, disables, updates and removes them. It gives a host
  the toolbar (each extension's action per tab, with its badge, and what a
  click does), mounts popups sized as their documents ask, names options
  pages, turns `chrome-extension://` URLs into ones a frame navigates to,
  and tells every change through `onChange`. Every call rejects with an
  `ExtensionError` whose `code` says what went wrong. (extensions suite.)
- The service worker keeps the extensions: each package as one blob with
  an index of its files, so an install is one write however many files it
  has, and each extension's pages on an emulated origin of its own, so
  their storage, cookies and caches are theirs alone. Content scripts are
  injected by the worker into the documents they match, at document_start
  once the page's root element is written and before its first script, at
  document_end and at document_idle, in ISOLATED, MAIN and USER_SCRIPT
  worlds; the page never sees the extension's `chrome`, and a page's CSP
  or Trusted Types do not stop them. A document no extension reaches gets
  nothing, and the inject bundles carry no extension code. The runtime is a
  new dist file, `extensionsRuntime.js`, served by its `init.assets` name
  (`extensionsRuntime`).
- Extension contexts message each other over a channel of their own, not
  through the host page: a content script's round trip to its service
  worker, and a port's, take well under a millisecond. chrome.storage
  writes one record per key and resolves once it committed. webRequest
  runs in the worker on the requests it sends on, with real headers and
  tab ids, and may cancel, redirect and change headers for an MV2
  extension with webRequestBlocking (or a policy-installed MV3 one), within
  500 ms. declarativeNetRequest's rulesets and calls go to the worker's
  DnrHost (docs/extensions-dnr.md), which keeps its state with the
  extension's, and a disabled extension's rules stop. Extension pages' and backgrounds' requests go through
  the transport, cross-origin ones to the hosts they have permissions for
  included, and `chrome.cookies` uses STomp's cookie jar.
