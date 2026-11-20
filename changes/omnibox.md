### Demo and API

- `controller.suggest(text, { engine, endpoint, limit, signal })` answers a
  search engine's completions for what was typed into the host's own
  address bar, on `StompController` and `RemoteController`. It asks the
  engine's OpenSearch suggest endpoint through the controller's transport,
  so a host needs no endpoint of its own for engines that send no CORS
  headers. The request is the host's: no proxied page's cookies,
  partition, origin or referrer, no cookies at all, and the fields Chrome
  sends for a request of the browser's (`Sec-Fetch-Site: none`, the user
  agent, the languages). `SEARCH_ENGINES` lists Google (the default),
  DuckDuckGo, Bing, Brave and Startpage (which asks DuckDuckGo's), and
  `engine` takes an id or a `SearchBuilder` template; `endpoint` takes any
  other engine's. Checked against all five through a local holyWisp on
  Chrome 157: each answers in 60 to 230 ms, and Brave's own endpoint
  answers a regular Chrome user agent (HeadlessChrome's gets 429). The
  controller bundles grow by about 3.2 KB (1.2 KB gzipped); the inject
  bundles are unchanged.
- The omnibox module (`src/omnibox/`, after SystemYA's): `dist/omnibox.js`
  (the classic script global `Omnibox`, named by the new
  `init.assets.omnibox` and `StompController.DEFAULT_ASSETS`) and
  `@sysce/stomp/omnibox` (`dist/omnibox.mjs`) put a dropdown of ranked
  suggestions under any input. Local rows (open tabs, a frecency-ranked
  history kept in localStorage under `omnibox:visits`, bookmarks) rank at
  once; the engine's completions come 250 ms after the last keystroke for
  two characters or more, one request at a time, and an answer for older
  text is dropped. The input is an ARIA combobox: the arrows go round the
  ends, Tab fills, Enter opens the highlighted row or lets the form
  submit, Escape closes, Shift+Delete forgets a history row, and a click
  in the empty box shows top picks. No proxied page loads it.
- The demo's two address bars are that omnibox in place of the TLD list:
  "Switch to tab" rows (the top bar leaves out the tab on show), the pages
  the tabs visited, the bookmarks and Brave's completions. The server's
  `/suggestions` route is gone; nothing else used it. While the list is
  open the top bar's bottom corners are square and the list hangs flush
  from it, as wide as the box, at phone widths too (it was rounded, and
  at 320 px the box was wider than the list). (demo-omnibox and
  omnibox-unit suites.)
