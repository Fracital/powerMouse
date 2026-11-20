### Fixes

- A tab that was open during a deploy says that it needs a reload. The
  browser installs the new service worker, the controller adopts it, and
  the handshake finds the worker newer than the page; nothing newer comes,
  so no `rebind` either, while the console said "the new worker has not
  activated yet, continuing with the old one". `stale` now has `newer`:
  `'worker'` when an update check found nothing newer than the worker (the
  console says to reload the page to run its build), `'controller'` when a
  newer worker is installing (the old message, and `rebind` when it
  activates), null when neither could be told. The demo's status says
  "reload the page" in the first case. stale-direction plays both with
  fake workers.
