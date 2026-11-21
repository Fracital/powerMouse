### Dependencies

- tor-js is the Fracital build at 789147d, the same wasm
  (`2e435140...`) in a package of 5.3 MB instead of 41 MB: its dist/ keeps
  only the `wasm-file` entry, the wasm and the types, and every export of
  the package (the default one too) is `wasm-file`, so no import reaches
  tor-js's CDN loader (deploy/tor-js/publish.sh). tor-streams, demo-tor,
  offline-html and the Tor smoke pass on it.
