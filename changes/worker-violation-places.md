### Fidelity

- A `data:` worker's violation names the place of the code that made the
  request, as natively: it named none, since the worker took the inject's
  own frames for the page's. The worker reads the proxy's origin from
  where its bundle came, so its frames are the inject's again, there as
  in any other worker.
- A `blob:` script's positions are the page's own, as a script file's: the
  service worker's rewrite of it carries the map of itself to the page's
  Blob. A `blob:` worker's import() violation names its specifier's column,
  as natively.
