### Fidelity

- Chrome extensions get what a 16-extension audit found missing against
  Chrome 157 (extensions suite, compat probe):
  - `runtime.getManifest()` answers the localized manifest, so Violentmonkey's
    popup reads its name, not `__MSG_extName__`. Chrome leaves `__MSG_` in
    a page's HTML and title as it is, and so does STomp.
  - A user script's world with messaging gets Chrome's `chrome`: the page's
    `csi` and `loadTimes` and a `runtime` with `onMessage` and `onConnect`,
    which Tampermonkey (11 errors) and Violentmonkey (4) read.
  - `tabs.onCreated`, `onUpdated`, `onActivated`, `onHighlighted` and
    `onRemoved` fire from the host's frames, and `webNavigation` is no
    longer a stub: commit, load and history events with real tab ids,
    URL filters, `getFrame` and `getAllFrames`. Privacy Badger now records
    its tabs.
  - Content scripts run in JSON and text documents, which are served as
    the HTML Chrome makes of them, so JSON Formatter formats JSON.
  - An extension's own scripts and styles load past the page's CSP, as
    Chrome lets them, and web_accessible_resources' `matches` judge the
    origin that asked even when a referrer policy sends no Referer, so
    Wappalyzer's onboarding page runs its js.js and dom.js.
  - `executeScript` runs in a sandboxed frame without `allow-scripts`, as
    in Chrome: Bitwarden's autofill no longer fails with "Could not load
    the script".
  - A popup is sized as Chrome sizes one, to its min-content width and
    measured again on every change: Bitwarden's popup is 480 px wide (it
    was 48), and a popup that renders late grows with it.
  - A page's own global named `Text` (a bundle's top-level `var Text`) no
    longer breaks the inject's writes of a style element's text: Grammarly's
    popup renders (it was blank and 25 px wide).
