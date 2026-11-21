### Fixes

- offline.html's vibeOS switch works in Firefox: vibeOS resolves its
  root-relative paths against `location.origin`, which Firefox reads as
  "null" on file:, and the desktop never loaded ("URL constructor: null is
  not a valid URL"). Its module reads `file://` there, as Chrome reads a
  file: page's origin. npm run test:firefox switches a tab of the saved
  file into vibeOS and back (its document kept, the desktop's files the
  file's own, a game from a blob: URL) and runs the file's Tor mode on the
  suites' stand-in (the client bootstraps in its worker, a page loads, its
  IndexedDB is kept across a reload), which needed nothing of Firefox's
  own.
