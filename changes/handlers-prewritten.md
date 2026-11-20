### Performance

- The service worker rewrites a document's handler attributes (an
  `onclick`) with its inline scripts and sends where each one's tag ends,
  so a frame neither rewrites nor places them: a frame with one handler
  costs about 3.5 KB more than one without, where it cost about 11 KB
  (Chrome 157). The scan reads only the tags around a handler, about 0.2
  to 0.7 ms a MB of markup.

### Fixes

- Two handler attributes of the same text in different places now each
  name their own line and column in an error's stack, as natively; every
  one after the first named the first one's.
