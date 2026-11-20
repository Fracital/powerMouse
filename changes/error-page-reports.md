### Fixes

- An error page reports its navigation like a proxied document. When the
  worker answers a failed document with the host's `errorPage` or its own
  built-in page, a script it puts in the page's head posts a navigate report
  to the host with the real URL that failed and the page's title, once the
  page's own scripts ran and again when the title changes. `frame.url`,
  `frame.title`, `onNavigate` and the `navigate` events now show the failure
  instead of the page before it: `Frame.url` was null and the title stayed
  the last page's. The failed document's `onRequest` report now names the
  frame, so a host can tell which tab failed; its `status` stays 0 for a
  transport failure (the RequestInfo JSDoc says why), and the page itself
  has the 502 or 504 as `stompError.status`. The same holds for a
  navigation the content blocker, a host rule, an extension's
  declarativeNetRequest rule or its blocking webRequest listener blocks. examples/error.html sets
  `document.title` from the failure's kind and has a title for kind
  `controller`. A page for an address whose controller is gone, or for an
  unknown inline document, still sends no report: its URL is a route, not
  the real one. (error-page-reports suite, both modes.)
