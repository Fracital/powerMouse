### Build

- Reading the browser's own securitypolicyviolation events back as the
  page sees them (whether one reaches the page, the URLs and the sample it
  names) is part of the violations part (`src/inject/dom/violations.ts`),
  made at the first trusted violation of a page with a policy of its own.
  Without the part the event is stopped and its URL and sample getters
  throw, so no proxy URL reaches the page.
