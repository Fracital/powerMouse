### Demo and API

- offline.html has Tor mode: the Tor toggle is offered in the file, and
  its Tor client (tor-js's wasm-file entry, arti's wasm and the tor-client
  modules, 2.6 MiB of the payload) runs in a classic worker of the file's
  page, over the file's wisp server, since Chrome starts no SharedWorker
  and no module worker of a blob: URL on file:. Each tab runs a client of
  its own; its state is in the file:// page's IndexedDB, kept across
  visits, so a later visit bootstraps in about 2 s instead of 4. The
  file's notices name the Rust crates of arti's wasm
  (`node scripts/crate-notices.mjs --only tor-js`). The offline-html suite
  checks Tor mode in a build with a stand-in for the Tor network
  (`scripts/build-offline.mjs --tor-stand-in`), and
  `OFFLINE=1 node test/tor-client-smoke.mjs` runs the Tor smoke on the
  file. Download no longer says the file has no Tor mode.
- `STOMP_CONFIG.torClient` may be an object naming where the client's
  files are, for a host that serves them under names of its own:
  `{ module, sharedWorker, wasm }`, each a URL (`sharedWorker: false` for
  none), any left out at `/tor-client/`. The transport hands `wasm` to
  tor-js, so the wasm need not sit beside tor-js's module.
