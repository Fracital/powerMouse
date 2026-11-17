### Security

- A worker's `navigator.permissions.query()` reads its site's own state, as
  a document's does; before, it read the browser's state for the proxy
  origin, which another site may have been granted (`granted` for a site
  that was never asked), and heard that state's changes.
  (adversarial-grants.)
