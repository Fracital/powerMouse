### Fixes

- A proxied page that sends COOP same-origin and COEP require-corp is
  cross-origin isolated in Safari and every browser on iOS, as natively:
  the demo's page sent COEP credentialless, which WebKit does not have, so
  neither it nor any proxied page was isolated there and a game that needs
  SharedArrayBuffer (blockshooter.club) stopped at its isolation check. The
  demo's page and every document and worker the service worker serves to an
  isolated host now say require-corp, which changes nothing a page sees in
  Chrome and Firefox. In WebKit, where every frame of an isolated page is
  isolated, a document that is not isolated natively reads
  `crossOriginIsolated` false and has no SharedArrayBuffer (coi-engines
  suite, which drives WebKitGTK where it is installed).

### Demo and API

- The demo's pages send `Cross-Origin-Embedder-Policy: require-corp`
  instead of `credentialless`, and README.md asks the same of a host that
  wants proxied pages isolated.

### Known limitations

- In WebKit a page with COOP and COEP credentialless is isolated through
  the proxy (Chrome's rules) and not natively, and a worker of a page that
  is not isolated reads `crossOriginIsolated` true.
