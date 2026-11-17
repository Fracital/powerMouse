### Fidelity

- A `<meta http-equiv="refresh">` (or a `Refresh` header) to a `data:`
  document is rewritten like a frame's `data:` source, so the document's
  scripts no longer run unproxied; the refresh URL is trimmed as the URL
  parser trims it, so a no-break space before `javascript:` is a relative
  path, as natively (`rewriter-unit`, `adversarial-parse-html`).
