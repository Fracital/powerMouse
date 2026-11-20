### Fidelity

- A frame inside a popup no longer posts STomp's messages for the host to
  the popup's page. The host is never above a popup, so the page's own
  `message` listeners heard what natively is never sent: the frame's
  service worker client id, its history steps and its user activation. A
  page that forwards what its popup hears, or listens for one message only,
  then missed the message it was waiting for (the web-platform-tests
  `cookies/samesite/about-blank-toplevel.https.html` and
  `about-blank-subresource.https.html` time out that way).
