### Performance

- A proxied top makes the rewriter library's realm (a frame of its own) the
  first time a rewrite needs it, not while its shell runs: a revisit whose
  scripts the worker wrote often needs none. The frame goes into a closed
  shadow root of an element of the realm's own, where its load event stops
  short of the page's listeners and `window.frames` leaves it out, and its
  insertion is no mutation record. The shell's inline script on a third load
  went from about 19.4 to 16.3 ms, and a third load from 48 to 43 ms
  (bench article, Chrome 157). (realm-unseen suite.)
