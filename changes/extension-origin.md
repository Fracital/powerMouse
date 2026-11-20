### Fidelity

- An extension sees its origin as `chrome-extension://<id>` wherever Chrome
  shows it, while STomp keeps serving it from `https://<id>.invalid`:
  `runtime.getURL`, a message sender's `url` and `origin`, tabs' and
  webNavigation's URLs, the initiator of its requests, its pages'
  `location`, `document.URL`, `baseURI` and `domain`, the URLs they read
  back, its service worker's `location` (its script's), and the origin of
  its documents' messages, in a web page too. A `chrome-extension://` URL
  loads wherever it is written. Tampermonkey's popup lists the tab's
  scripts (it was empty: its background refused a sender of another
  scheme).
