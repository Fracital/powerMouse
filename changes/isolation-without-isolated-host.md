### Origin isolation

- A proxied page that is cross-origin isolated natively is isolated under a
  host whose page is not, in Chrome 137 and later: the service worker
  serves it, and every document in its frames, with a
  Document-Isolation-Policy of its own, so `crossOriginIsolated` is true,
  SharedArrayBuffer is there for it and its dedicated workers, and its
  embedder policy refuses the loads, workers and frames it refuses natively
  (games such as blockshooter.io/play-staging stopped at their isolation
  check on hosts that cannot isolate their page for ads or sign-in
  popups). A page that is not isolated natively stays as it was, and so
  does every other browser. The policy puts the page in an agent cluster
  the host's page does not reach, so what the controller read from it
  synchronously (its address, history and buttons, `back()`, `forward()`,
  `reload()`, user activations, the host's geometry, the compiled core
  module) now goes through a hidden document of the proxy's origin in that
  cluster, which the controller starts the first time such a page is shown
  (src/controller/apart.ts). (cross-origin-isolation suite: the "host is
  not isolated" rows now compare with native.)

### Demo and API

- The navigate event's `info.isolation` is `'wanted'` for a page that is
  isolated natively and is shown without isolation (a host that is not
  isolated, in a browser without Document-Isolation-Policy), so a host may
  offer it a window of its own.
