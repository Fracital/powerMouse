### Fixes

- `history.back()`, `forward()` and `go()` made twice in one task step the
  history twice, as natively: the browser applies each step when its task
  runs, from wherever the steps queued before it leave the history, and the
  proxy counted every one from the entry current at the call, so
  `history.go(-2); history.go(-1)` ended two entries back where Chrome ends
  three back (web-platform-tests' history `004.html`). The same calls on the
  History of a document that is not fully active (a removed frame's) throw
  the browser's SecurityError where they threw a TypeError out of the inject,
  and on a frame's initial about:blank they do nothing where they threw.
  Called on another window's History
  (`frame.contentWindow.history.back.call(history)`) they step that
  window's history, as natively, where they stepped the frame's or threw.
  (wpt-history suite.)
