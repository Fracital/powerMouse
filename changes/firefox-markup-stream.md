### Fixes

- A page whose markup comes in more than one piece renders in Firefox
  (Wikipedia painted nothing): Firefox's document.open() of a document
  still loading cancels every request of it in flight, a fetch() too, and
  the shell opens its document for the page right after its script, which
  had started the read of the markup stream. The read now begins once the
  document is opened. (npm run test:firefox.)
