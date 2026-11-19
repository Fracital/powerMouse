### Fixes

- A proxied page is cross-origin isolated by the rules of the browser it
  runs in, as natively. The service worker judged every page by Chrome's:
  in Safari (WebKit), which has no COEP credentialless, a page with COOP
  and credentialless was isolated through the proxy and not natively, and a
  frame or worker with credentialless loaded under an isolated page where
  natively it does not; in Firefox and Safari, which isolate every frame of
  an isolated page, a frame that gave up the `cross-origin-isolated`
  permission or was of another origin read as not isolated, and a page with
  a Document-Isolation-Policy (Chrome's alone) read as isolated. Where the
  rules would differ the service worker asks the controller's page, which
  asks the browser with a worker and two hidden frames, once.
- A dedicated worker of a page that is not cross-origin isolated reads
  `crossOriginIsolated` false and has no SharedArrayBuffer in Safari and
  Firefox too: its route (or a blob: or data: worker's bootstrap) tells it
  its creator's state.
- A `credentialless` attribute on a frame makes a credentialless frame only
  where the browser has them (Chrome). In Safari such a frame without an
  embedder policy loaded under an isolated page through the proxy and does
  not natively.
- In Chrome a dedicated worker of a credentialless frame whose document
  sent no embedder policy starts though its script sends none, as natively:
  the service worker refused it.
