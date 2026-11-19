### Performance

- The service worker gets the wasm modules sooner when a controller shakes
  hands. Their 2 MB now go as the first message on the handshake's own
  port, where they went in the handshake message, which Chrome routes
  through the browser's process: 5.6 ms for them on Chrome 157, where a
  port takes 1.8. The worker also fingerprints the bytes four at a time.
  From the page's send to the worker's ready, the boot's handshake takes
  10.8 to 16.7 ms (median 12.1), where it took 13.3 to 22.2 ms (median
  15.1). A worker of an earlier build, which does not say it took the
  modules from the port, is sent them after the handshake, as for modules
  that load late.
