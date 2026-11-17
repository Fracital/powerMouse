### Fidelity

- A document served with a content type whose essence is not already lower
  case and trimmed (`Text/HTML`, `text/html`) is recognised as HTML and
  gets the proxy's shell, matching how the browser selects a parser, so its
  scripts no longer run unproxied (`adversarial-parse-html`).
