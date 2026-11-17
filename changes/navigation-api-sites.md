### Origin isolation

- The Navigation API keeps a document to its own site, as natively. Every
  proxied site is the proxy's origin to the browser, so a navigation to
  another site read `canIntercept` true and `intercept()` committed that
  site's URL in the document (which then had that site's storage and
  cookies), a precommit handler's `redirect()` to another site was judged
  by the proxy's origin (its SecurityError named that origin, and a
  redirect to the page's own site was refused), `traverseTo()` went to
  another site's entry by its key, and a traversal into another site's
  entry fired `navigate` with that entry's URL and state. Now
  `canIntercept` is false for a destination of another site, and
  `intercept()` and `redirect()` throw the browser's SecurityError about the
  page's own origin and URL; `redirect()` goes to the page's URL routed;
  `traverseTo()` knows only the keys of the site's run of entries around
  the document (InvalidStateError "Invalid key" otherwise), a traversal
  past them is not heard of, a traversal's `destination.index` counts in
  that run, and `PageSwapEvent.activation` is null for a navigation to
  another site. (navigation-api, adversarial-navigation suites.)
