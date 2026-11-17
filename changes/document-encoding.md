### Fidelity

- A document keeps its encoding through the proxy. The worker decoded a
  legacy-encoded page (Shift_JIS, EUC-JP, EUC-KR, GBK, gb18030, Big5,
  ISO-2022-JP, windows-125x) and served it as UTF-8, so the browser
  encoded the query of its links, its GET forms, its XMLHttpRequests, its
  beacons, its EventSources, its workers' URLs and its navigations as UTF-8
  (a search reached the server as other bytes than natively and matched
  nothing), and `document.characterSet`, `charset` and `inputEncoding` read
  UTF-8. The shell now goes out in the document's own encoding (as ASCII,
  whatever is not ASCII escaped in its scripts' strings), so the browser
  gives the document that encoding, and the inject parses the URLs it
  routes with the query in it, by the browser's own encoder (a link of the
  document): an element's URL and its read-back, a form's action and its
  sealed GET query (in the form's accept-charset when that is the
  document's encoding; another legacy one goes as the browser writes it),
  XMLHttpRequest, sendBeacon, EventSource, Worker, SharedWorker,
  `location.href`, `assign`, `replace` and `window.open`. What Chrome
  parses as UTF-8 in such a page stays so (`new URL`, fetch, WebSocket,
  history, `navigation.navigate`, `<base href>`, CSS), and an element of an
  inert document reads back in UTF-8, as natively. A rewritten stylesheet
  now goes out as UTF-8 and says so, decoded by its byte order mark, its
  Content-Type charset or its `@charset` (it was read as UTF-8 and then
  served under the origin's charset), and a classic script that named no
  type goes out as UTF-8 script (`src/server/charset.ts`,
  `src/server/rewrites.ts`, `src/inject/dom/Client.ts` `encodingParse`,
  `src/inject/dom/modules/FormQuery.ts`, the slow paths a deferred part,
  `src/inject/dom/legacyEncoding.ts`). (document-encoding,
  wpt-encoding-legacy, wpt-url-elements, wpt-workers-basics.)
