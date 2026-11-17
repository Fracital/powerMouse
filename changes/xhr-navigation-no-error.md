### Fixes

- An XMLHttpRequest still in flight when its document is left (its frame
  navigated or removed) no longer fires an error event. Chrome cancels the
  document's loads when it is left and the rejection of the request STomp
  made reaches the first script that runs after, a pagehide listener's
  (every proxied document has one since its observers are disconnected
  there), so the page heard an error from a request natively dropped
  without events. The error is now told in a task of the document's own,
  which never runs once the document is gone. (wpt-xhr-events
  abort-during-navigation.)
