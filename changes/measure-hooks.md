### CI

- A measurement suite, measure-hooks, times about 40 small kernels of
  common page work natively and through the proxy, side by side: reads of
  `location`, `document.URL`, `document.cookie`, `top`, `parent` and
  `frames`, innerHTML, insertion of scripts and links, URL and plain
  attributes, fetch, XHR and postMessage setup, and mutation observers. It
  runs them in a frame of another site than its parent, prints each one's
  median round and its ratio to native, and fails when a kernel's checksum
  differs from the native one. `SKIP_MEASUREMENT=1` leaves it out.
