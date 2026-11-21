### Fixes

- offline.html: a frame in a site's markup loads its document. Its
  document gives it the call page as its srcdoc before the parser inserts
  it (the host hands the markup over, `$stomp$offlineCallPage`), where the
  frame had gone to the call page's `file:///stomp/` URL first, which
  nothing serves, and its document's call was spent on that error page.
  No request of a tab goes to file: or past the transport any more: a
  called document holds its load for a frame with no image there (the
  hold's `file:///stomp/...?hold=` URL), and the page asks the relay for
  WebTransport only by its own name and path (a wss: relay), never for its
  `/webtransport.json`, which a file: page's fetch was refused anyway.
  v86's sound starts: a worklet's module from a `blob:` URL is added as a
  `data:` URL of its text where the page's origin is opaque (file:), which
  refused the `blob:` one (`offline-vibeos`, which now checks the whole
  session's requests).
