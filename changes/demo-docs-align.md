### Demo and API

- The demo no longer passes a `rewriter` option (`?js`, `?wasm`,
  `STOMP_REWRITER`): the controller has run the wasm core for every thread
  since `init.rewriter` went, so the option was read by nothing.

### Docs

- demo/README.md follows the code: the sandbox proxied frames get is
  `DEFAULT_SANDBOX` (with `allow-popups-to-escape-sandbox`,
  `allow-presentation`, `allow-orientation-lock` and
  `allow-storage-access-by-user-activation`), the frame-ancestors policy is
  `'self' <host>`, the controller frame reads the host from its referrer
  (so a host page with `Referrer-Policy: no-referrer` gets no controller),
  the site pool is off unless `STOMP_SITE_POOL` is set, the pinned epoxy
  build carries WebSocket frames both ways, and the deployment is described
  without a CDN in front and without the server's own names.
  `STOMP_REWRITER` is gone from it.
- docs/webrtc-over-wisp.md says the stack it plans is the one a proxied
  page's `RTCPeerConnection` runs on, with media built, and that the
  `WebTransport` stand-in carries sessions over wisp UDP.
- deploy/epoxy/README.md lists epoxy-tls 0059 (a host that drops the
  real-ECH handshake is retried without ECH), 0060 (a 206 is passed on
  still encoded) and EpoxyTransport 0053 (epoxy.wasm shipped as a file of
  its own beside the module).
