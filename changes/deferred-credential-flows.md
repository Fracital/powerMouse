### Performance

- FedCM's protocol and account chooser, and the guard that keeps a page's
  WebAuthn calls from the browser's own authenticator and from the
  network, are a deferred part (`src/inject/dom/credentialFlows.ts`), made
  at a document's first identity request, disconnect or WebAuthn call with
  options. The Credentials module keeps the interfaces and hooks it had.
  `injectDocument.js` is 6.2 KB smaller.
