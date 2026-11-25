### Fixes

- offline.html opened from a file starts again. Since ad212d731
  (2026-11-24) the controller refused any worker that was neither a
  ServiceWorker nor a ServiceWorkerRegistration, and offline.html's
  stand-in for the worker is neither; it now refuses only an empty one,
  which is what Playwright's blocked `register()` gives.

### Fidelity

- A module script served as windows-1252 is decoded as windows-1252 again
  in Chrome before 159, as Chrome 152 and 157 do; Chrome 159 reads it as
  UTF-8, and 97879b009 had made every Chrome do so. The worker reads the
  browser's own major version once as it starts.
