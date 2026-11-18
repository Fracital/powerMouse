### Fidelity

- A page's `location.assign()`, `location.replace()` or `location.href`
  write on a frame still on its initial about:blank starts in the call and
  cancels the frame's `src` navigation under way, as natively, where the
  proxy started it only after telling the service worker of its initiator.
  By then the frame's `src` had committed, so the frame loaded a document
  natively never commits, and the navigation was sometimes lost: started
  between that document's commit and the write of its markup, it was
  aborted by the `document.open()` that write begins with (wpt-location's
  `assign-with-nested-iframe.html` and `replace-with-nested-iframe.html`
  timed out in 4 of 10 runs, and now pass in 18 of 18). When the frame's client is of
  the navigating document's realm (a page navigating a frame or popup it
  made), the browser takes that document for the initiator, its Referer
  under its referrer policy included, and nothing is announced. (wpt-location
  suite.)
