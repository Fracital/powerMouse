### Fidelity

- An image of another site in an about:blank frame the page built (a
  document no service worker controls) loads with nothing in the console,
  as natively. The proxy seals such an image's copy (its URL is made in a
  worker that is then terminated, so nothing can fetch it) and hands it
  over once a fetch of a second URL that worker made fails; that fetch was
  the document's own, and Chrome reported each one as "Failed to load
  resource: net::ERR_FILE_NOT_FOUND" naming a blob: URL the page never
  made (chase.com showed four a load, from the fraud script's pixels). A
  worker of the inject's asks it now, whose failed fetch Chrome does not
  report (measured, plain Chrome 157); it ends after five idle seconds.
  (sealed-console suite, both modes, against the page loaded natively.)
