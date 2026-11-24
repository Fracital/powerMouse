### Fixes

- A `register()` promise that resolves empty (Playwright's
  `serviceWorkers: "block"` does this, it does not reject) no longer
  throws `Cannot read properties of undefined (reading 'state')` on a
  later turn. `wait()` rejects saying the call resolved without a
  service worker registration.
