### Transport

- With `webTransport`, the first transport's carrier is chosen while
  epoxy's module loads, and epoxy's wasm loads while the carrier is
  chosen. The controller frame and the demo make the controller before
  the service worker is activated (its first handshake still waits for
  it), so the transport worker, epoxy and the carrier come up during a
  first visit's install.
