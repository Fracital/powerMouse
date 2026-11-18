### Fixes

- A form a report-only `form-action 'none'` refuses fires one violation,
  as natively, not four: the browser's copy of the directive refused the
  form's route three times over and reported each, on top of the
  inject's own report (csp-navigation).
