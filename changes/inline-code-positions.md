### Fidelity

- Code the inject rewrites reads its positions as natively: a script of the
  page's markup (its frames name the document's lines, and the first
  line's column counts from where its text starts), an event handler
  attribute of the markup (counted from where its start tag ends), a script
  the page writes or inserts, eval, `new Function`, a string timer and a
  javascript: URL. An error's stack (each frame, an eval's origin, a
  structured stack's `getLineNumber`, `getColumnNumber` and
  `getPosition`), an error event's place, a long animation frame script's
  `sourceCharPosition` and a CSP violation's place read through a map of
  the rewrite. The core module makes that map apart from the output (flag
  1024), which is the plain rewrite byte for byte; the inject finds it by
  the hash V8 names a frame's script by. The service worker places a
  prewritten markup script in the document as it streams it. error-surfaces now compares every place with native (333 in
  each mode), all as natively but those it lists; csp-scripts compares the
  places of refused string code in a script file and in the markup, and
  performance-entries a long animation frame of a function of the markup.
- A CSP violation of eval, `Function` or a string timer names the page's
  call (sourceFile, lineNumber, columnNumber), as Chrome's does, and so
  does one of a handler the page's code sets; they named none.
- Still the rewrite's: an eval's origin where the call that made the code
  is not the frame below it: a `new Function`'s names the call that ran
  the function, and a function eval made, called later, names the
  output's place in no script. A long animation frame entry has no hash,
  so a markup script's is found by the function's name at the mapped
  place, else as the only kept script long enough.

### Performance

- A rewrite with its map apart takes 6% longer than without (16.3 ms per
  MB against 15.4 on the bench's twelve biggest scripts), as one with the
  map in it does; the core module counts a script's lines eight bytes at
  a time where none ends a line, which took the map's own cost from 13%.
  The inject holds the newest 4,096 maps of code it rewrote with their
  output, and hashes those held only when a frame of no file is first
  placed (about 12 ms per MB of code), in a deferred part. Hashing in wasm
  instead had made a rewrite 63% slower.
