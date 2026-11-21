### Fixes

- A controller whose service worker answers with another build no longer
  waits forever when the host has a service worker of its own at a wider
  scope (powerMouse's app worker at `/`): the registration nearest the
  directory counts only when its worker is STomp's, from the directory, so
  with no STomp registration to update from `wait()` resolves on the worker
  at hand with `stale` set, as before the app worker (`version`).
