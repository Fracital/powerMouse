### Fidelity

- A proxied document's permissions policy knows Chrome 158's two new
  features. `web-app-installation` (`navigator.install()`) has the `self`
  default allowlist, and a frame of another site without an allow
  attribute naming it has it off, as natively; before, the browser saw the
  proxied frame as same-origin with its parent and gave it the feature.
  `focus-without-user-activation` has the `*` default and is served off
  where the page's policy turns it off. Both are left out below Chrome 158,
  which does not know them (`FEATURE_VERSIONS` in src/server/clientHints.ts).
