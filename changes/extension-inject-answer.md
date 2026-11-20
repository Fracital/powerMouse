### Fixes

- An extension's `executeScript`, `insertCSS` and `removeCSS` (scripting's
  and tabs') answer once each targeted document has run the injection, as
  Chrome's do. They had also waited for the contexts of a document's
  isolated and USER_SCRIPT worlds, which never answer, so each call took
  its full 10 s bound. A frame's world is no document of its own
  (extensions suite).
