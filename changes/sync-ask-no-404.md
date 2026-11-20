### Fixes

- In Chrome and WebKit, the first proxied documents of a profile have no
  404 in their console. A document that did not know yet whether the
  browser lets the service worker answer a page's synchronous request
  asked once at its address's `xhr?a=`, which Chrome and WebKit send past
  the worker to the host's server, where no file is: a 404, logged at the
  synchronous bridge's code in `rewriterLib.js` (about 7 in each run of
  the extension audit, read as a 404 for the rewriter library). Such a
  document now finds out with a HEAD request for the rewriter library's
  file, which the worker answers itself and the host's server answers as
  the file it serves (sync-asks).
