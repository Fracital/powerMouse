### Build

- What a change of the cookie jar changed of what a page has seen through
  its `cookieStore` (the change events) is a deferred part of the document
  bundle, in the group of the Cookie Store methods
  (`src/inject/cookieStoreMethods.ts` cookieChanges), made at the first
  change after the page's first look; the service worker emulation's
  methods do not carry it. Without the part no change event is dispatched.
