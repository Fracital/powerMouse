### Fidelity

- A base a report-only `base-uri 'none'` refuses (in the markup or
  inserted by a script, under a header policy) fires one
  securitypolicyviolation event, the browser's own and trusted, as in
  Chrome: the inject reported it as well, and the page saw two
  (csp-base-uri, deferred-refusals).
