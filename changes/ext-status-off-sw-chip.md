### Demo and API

- The address bar's status chip reports only the service worker, the
  transport and the tab's load. Pinning or unpinning an extension, removing
  one and a failed extensions call no longer write "Extension pinned",
  "Removed ..." or "Extension: ..." there. As in Chrome, a pin change is
  announced to a screen reader only, a removal shows as the button leaving
  the bar, and a failed call goes to the Extensions page's status line when
  that page is open and to the console otherwise (demo-extensions suite).
- The Pack extension view is spaced like Chrome 157's dialog. Each label
  sits 8 px above its field, fields are 16 px apart and 16 px below the
  note, and Browse is 12 px after its field and level with it
  (extension-manager suite).
