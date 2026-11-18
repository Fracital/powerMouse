### Build

- The build id (`<version>+<hash>`) is a hash of what the bundles are
  built from (`src`, `assets`, `build.js`, the build's own scripts,
  `tsconfig.json`, `package.json` without its scripts, and
  `package-lock.json`) instead of the commit. A commit that touches only
  the tests, docs, demo, changelog, CI or deploy files now keeps every file
  in `dist/` byte for byte, so browsers keep the hashed bundles and the
  service worker is not reinstalled; one that changes an input gets a new
  id, and with it a new service worker, as before. The service worker,
  controller and inject bundles compare the id exactly as strictly, and the
  build fails if any bundle reads a file outside those inputs.

### CI

- The reproducible-build check also adds a file to the tests, docs, demo
  and CI and checks that `dist/` stays the same, and adds one to `src` and
  checks that the build id changes.
