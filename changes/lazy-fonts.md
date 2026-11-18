### Performance

- A stylesheet copied for a document no service worker controls (an
  about:blank frame a page writes into, a document it opened) fetches its
  font faces as the text needs them, as natively, instead of every face up
  front: a Google Fonts sheet has a face for each subset and weight, and
  target.com's about:blank frame fetched 56 of them where Chrome fetches one.
  A face's source waits as a font of one empty glyph until the browser loads
  it; then it is copied and the face put back with the copy, and
  `document.fonts.load()` and `document.fonts.ready` answer once that copy is
  in. (lazy-fonts suite.)
