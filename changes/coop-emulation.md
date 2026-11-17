### Security

- Cross-Origin-Opener-Policy is emulated between proxied pages. The browser
  never saw a page's own policy (every proxied site is one origin to it), so
  a popup stayed reachable from its opener whatever either sent. The worker
  now decides, by Chrome's rule (measured in Chrome 157 on 19 cases), whether
  a popup's navigation leaves its browsing context group, from the opener
  policy facts the documents tell it, and makes the browser do it with a real
  policy of its own on the document it serves: the opener's window of the
  popup reads closed and takes no message, and the popup has no opener and
  no name. A frame of another origin than a top-level page with COOP
  `same-origin` opens its popups without an opener, and `window.open`
  returns null. Not under an isolated host, where every popup keeps the
  host's policy (coop).
- A document its own Document-Isolation-Policy isolates no longer reaches the
  documents of its origin that none isolates, nor they it, as across origins
  in Chrome (document-isolation).
