### Fidelity

- An emulated module service worker starts again without the network: the
  modules its script imports statically (and the ones they import) are
  kept with its version while it installs and served from there after, as
  the scripts a classic worker imports with `importScripts` already were.
  Before, a module worker that was stopped could not start offline, and a
  cache-first app built on one did not open (service-worker-offline suite,
  against Chrome with every worker stopped first).
- An update check compares the scripts the worker imported too, and a
  change to one alone installs a new version, as Chrome does (it compared
  only the main script, so a worker that is a small loader of its real
  code missed every update of that code). Imported scripts are fetched
  past the HTTP cache only for `updateViaCache: 'none'`
  (service-worker-updates suite, `importScripts` and a static import).

### Security

- A service worker's imported script whose URL redirects is a network
  error, as Chrome fails it (the registration rejects with Chrome's own
  message: "ServiceWorker script evaluation failed" for a classic worker,
  "ServiceWorker cannot be started" for a module worker, at once rather
  than after the worker's start timeout). Before, the redirect went to the
  browser, which followed it to the target's unrewritten route and ran the
  script there without the inject (service-worker-updates suite).
