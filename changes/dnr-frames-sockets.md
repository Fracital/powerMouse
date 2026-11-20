### Fidelity

- Nested frames get their frame ids from the service worker, which keeps
  them. `sender.frameId`, executeScript's `frameId` and
  onRuleMatchedDebug now agree, and a frame that navigates itself keeps
  its id.
- A WebSocket's or WebTransport session's handshake is in the tab and the
  frame of the document that opens it. Its declarativeNetRequest match
  had tab id -1 before, and the document's allowAllRequests now covers it.
- A main frame's redirected request stays in the navigation's tab.
- When a main frame's navigation was announced by neither the host nor a
  hooked document, its matched rules and action count now go to its tab
  once its document reports.
- webRequest's onBeforeRequest now fires before declarativeNetRequest
  matches the request, as in Chrome. A request that a rule blocks or
  redirects still reaches onBeforeRequest and then onErrorOccurred
  (`net::ERR_BLOCKED_BY_CLIENT`), and the rule wins over a blocking
  listener's answer. Privacy Badger's badge now counts the trackers its
  rules block (3 on theguardian.com).
