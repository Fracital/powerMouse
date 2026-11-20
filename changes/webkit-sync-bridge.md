### Fixes

- What a page asks for synchronously works in WebKit (Safari's engine)
  through the proxy, as natively. A synchronous XMLHttpRequest came back
  with status 0 after 30 s, localStorage and document.cookie threw a
  RangeError after 10 s, and the scripts a page wrote into an about:blank
  frame never ran: a page that waits in WebKit stops its service worker
  and its own workers until the wait ends, so no answer of the synchronous
  bridge could come. The controller learns that once, and each document
  there is now served its cookies and its stores with its shell, writes
  them asynchronously in order, and reads them again after a change. A
  synchronous request goes to the host, which makes it through the Wisp
  relay with the document's headers and cookies (HttpOnly ones too) and
  answers it whole; the cookies its response sets reach the jar. A script
  written into an about:blank frame loads from the host, which holds the
  load until the worker's copy of it comes. The demo serves both routes
  (`/stomp/sync-relay`, off with `STOMP_SYNC_RELAY=0`); a host without
  them gives such a request a network error at once. (sync-engines.)
