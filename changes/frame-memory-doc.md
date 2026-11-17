### Docs

- docs/frame-memory.md: where a proxied frame's memory goes in same-origin
  mode against native (the inject's realm, the markup's three trees, the
  links' markers, what the workers leave per load and keep), why worker
  memory is measured with and without the workers' collections and by
  deterministic counts, and the levers left (one tree for the markup pass,
  a table for the page's hrefs, the two bodies per script load).
