### Demo and API

- Chrome extensions' declarativeNetRequest rules run in the service worker
  (docs/extensions-dnr.md): `controller.dnr()` installs an extension's
  rulesets and makes its chrome.declarativeNetRequest calls, and every
  condition, action, priority rule, limit and error message is Chrome 157's.
  The rules are compiled once into an n-gram and domain index modeled on
  Chromium's, updated incrementally, and matched in about 10 to 20 µs a
  request, with no byte in the page's inject. uBO Lite's full rulesets
  compile with no cap, and on theguardian.com they block what they block
  natively.
