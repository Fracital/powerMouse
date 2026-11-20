### Fidelity

- A script file's positions are the page's own: an error's stack (each
  frame, an eval's origin, a structured stack's `getLineNumber` and
  `getColumnNumber`) and an error event's line and column name where the
  code is in the file the page served, not in its rewrite. The service
  worker's rewrite of a script file carries a compact map of itself to the
  page's text (flag 512, docs/rust-plan.md "Position maps"), which the
  inject decodes only when a position in that file is asked for.
  error-surfaces compares 199 places in script files in each mode, all as
  natively but five it lists: a function made with `new Function` names the
  place of the frame below it as where it was made (natively the
  `new Function` call), and a worker terminated mid importScripts reports
  no place. test/pages/error-surfaces-columns.js adds code the rewriter
  writes around, characters past ASCII and an async frame. Positions in the
  page's markup and in code with no file are still the rewrite's.

### Performance

- The map costs 2.72% of the rewritten output over the corpus and 4.0% to
  5.7% of rewrite time where it is written (script files only); the
  rewritten code itself is unchanged. `core.wasm` grows 4,070 bytes,
  injectDocument.js 1,141 and injectWorker.js 2,173.
