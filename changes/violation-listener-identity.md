### Fidelity

- A securitypolicyviolation event the inject fires (an enforced or a
  report-only one: a load, a base, a form, the page's code, a Trusted Types
  sink, a worker's connection) is one object to every listener of its
  dispatch, as natively: a function's, an object's `handleEvent`, the
  document's and the window's `onsecuritypolicyviolation`, and
  `window.event` all read the same trusted event, whose `constructor` and
  methods are the prototype's own. A listener was handed a view of its own
  that `window.event` was not, with bound methods, and an object's
  `handleEvent` and the `on` handlers read the event untrusted (csp-scripts,
  csp-base-uri).
