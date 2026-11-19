### Fixes

- A page's Content-Security-Policy meta applies to the scripts of its
  markup as natively. The inject judged a markup script as it copied the
  markup, before a meta in the same markup was live, so a plain inline
  script after a meta of `script-src 'nonce-abc'` ran, where Chrome refuses
  it. Each script of the markup is now judged as the parser prepares it, by
  the policies the document has then: a meta in the first chunk of the
  head, in a later one, or one a script inserts, applies to the scripts
  after it (nonce, hash, 'strict-dynamic' and 'unsafe-inline' as natively)
  and not to those before it. A refused external script is not fetched
  (not even by the preload scanner) and fires its error event; a meta
  outside the head is ignored, with Chrome's console error; each refusal
  logs Chrome's console message; and the page's ReportingObservers get a
  csp-violation report of each violation the inject makes, as the
  browser's reach them. (csp-meta-scripts suite, measured against Chrome
  157.)
