### Performance

- The service worker opens its settings and storage databases as it
  starts, and the cookie jar while the first handshake's settings
  transaction runs, so a controller's first handshake no longer waits for
  three IndexedDB opens in a row (handshake to ready 18.5 to 15.0 ms on
  a fresh profile). The settings database is opened once and shared by
  its callers, which opened a connection each before and never closed it.
