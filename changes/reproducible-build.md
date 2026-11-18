### Build

- The same tree builds byte-identical files in `dist/`. The modules the
  deferred parts share with the document bundle were numbered in the order
  the parallel part builds first asked for them, which varied from build to
  build and changed the rewriter library, the document bundles and every
  bundle that names their hashes; they are now numbered by file name. The
  source maps no longer name the checkout's path, and a build outside a git
  checkout names itself by a hash of its inputs instead of the time. A
  hashed file such as `injectDocument.js?<hash>` keeps its hash until what
  it is built from changes.

### CI

- The check job builds twice and fails if any file in `dist/` differs or
  names the checkout's path (`scripts/check-reproducible.mjs`).
