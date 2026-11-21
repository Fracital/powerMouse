### Fixes

- offline.html dials in Firefox as it does in Chrome, so a site's history,
  pushState and popstate, its Navigation API, its own frames, its classic
  and blob: workers and Google's search box work there from file: too
  (Firefox kept the written frames, where a frame of a page went to a
  `null/stomp/...` address and never loaded). Firefox reads a file: page's
  origin and a file: URL's as "null" where Chrome reads `file://`: the
  controller makes its call pages and routes on `file://` there, a call
  page's realm reads a file: URL's origin as Chrome does, and the call page
  takes its parent's message where Firefox lists that parent as
  `file://UNIVERSAL_FILE_URI_ORIGIN`. A browser with no Navigation API
  keeps the written frames.
- In Firefox, offline.html's POST requests (a form's, a page's fetch and
  XMLHttpRequest) went out with no body: Firefox's Request has no `body`,
  which the worker reads to know a request has one. The worker emulated in
  the page gives it one.
- A form's submission in a dialed tab in Firefox now makes an entry of its
  own, as natively and in Chrome: it replaced the page's (Firefox replaces
  on any submission of a document written with document.open(), which a
  called document is). npm run test:firefox runs offline.html's fixture page, the
  offline-html suite's site page and its link, Back, Forward, Reload, forms,
  location write and Navigation API through the file.
