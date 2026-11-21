### Fixes

- A dialed document's dedicated worker starts, in Chrome and Firefox: the
  document keeps its call page's Cross-Origin-Embedder-Policy
  (require-corp), and the browser refuses a worker whose script has none.
  The worker's script is served with the policy for a client that is a call
  page, as it is in a cross-origin isolated host. (npm run test:firefox.)
