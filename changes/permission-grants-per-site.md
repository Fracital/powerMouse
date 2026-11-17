### Security

- The browser's grants for the proxy origin no longer pass from one site to
  another: `getScreenDetails()`, `queryLocalFonts()`, `requestMIDIAccess()`,
  `navigator.clipboard.read()` and `readText()`, `getDisplayMedia()`, the
  callback `navigator.getUserMedia` and `webkitGetUserMedia`, a
  SpeechRecognition's `start()` and `navigator.storage.persist()` ask as
  `getUserMedia` does (the site's own state, the browser's prompt, the
  host's `onPermissionRequest`), and a refused site reads Chrome's own
  refusal, word for word. Before, a site that was never asked read the
  screens, 620 fonts, the clipboard and a camera stream, listened, and
  made its storage persistent once any site had been granted.
  (permission-gates, adversarial-grants.)
- A notification is shown only for a site that may show it (window and
  worker): one that may not gets Chrome's refused notification (an `error`
  event, the members as given), a worker's `Notification.permission` reads
  the site's state, a `tag` is the site's own and `icon`, `image` and
  `badge` are fetched through the proxy and read back as the page gave
  them. (permission-gates, adversarial-grants.)
- `<geolocation>`, `<camera>`, `<microphone>` and `<usermedia>` give a
  site that does not hold their permission no position or track and its
  own `permissionStatus`; before, `<geolocation autolocate>` delivered the
  position on another site's grant. (permission-gates,
  adversarial-grants.)
- `requestMediaKeySystemAccess` drops a configuration that requires
  persistent state or a distinctive identifier (one CDM store for every
  proxied site), and reads an optional one as `not-allowed`.
  (adversarial-grants.)
