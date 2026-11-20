### Performance

- The proxy starts sooner after `StompController.register()`. While the
  service worker installs, `register()` now fetches the wasm modules and
  the rewriter library, and starts the transport worker's script. The
  controller then takes them, where it began them only once the worker was
  activated. The bench's boot on Chrome 157 takes 109 to 134 ms (median
  113.5), where it took 117 to 141 ms (median 124.5). A transport worker
  script that fails to start is started again by the controller, which
  reports the failure as before. What no controller takes is let go after
  30 s.
