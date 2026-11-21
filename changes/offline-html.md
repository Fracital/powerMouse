### Build

- `npm run build` now ends by writing build/offline.html, and
  `npm run build:offline` writes only it: the demo and STomp in one HTML
  file of about 9.8 MiB that runs from file: or any static host with no service
  worker. Nothing new goes into dist/, the file is not committed (`/build`
  is ignored) and it is not in the npm package (`files` stays `dist` and
  `lib`). dist/serviceWorker.js runs unchanged
  in a dedicated worker the page starts (demo/offline/worker.mjs makes its
  scope there), and the controller talks to it as to a registered worker.
  Each document of a tab is written into a fresh frame that loads one fixed
  call page; the page fetches its document's route through the in-page
  worker and writes it into itself, and the inject's copies of its loads and
  the page's own fetch and XMLHttpRequest go the same way. Links, forms, a
  script's location writes, back, forward and reload are followed by the
  page, and the pages' mode (Settings, Page appearance) reaches each
  document. The bundles, the wasm modules (gzipped, decoded with
  DecompressionStream), the transports, the themes, the extensions page, the
  omnibox and the adblock snapshot are inside it; `--no-adblock` leaves the
  blocker out. The wisp server is JSON in one element at the top of its
  head, wss://holywisp.fracit.al/ unless STOMP_OFFLINE_WISP names another;
  `?wisp=` or Settings ("Wisp server", shown only in the file) change it at
  run time. The file ends with the licences and notices of every part it
  carries, read from each bundled package's licence file or from
  demo/offline/notices/, and the build fails when a bundled package has
  neither; the Rust crates of core.wasm, codec.wasm, blocker.wasm and
  stomp-h3 are named with their versions from the Cargo.lock files, their
  licence texts not yet included. check-reproducible builds it twice and
  compares.

### Demo and API

- The demo server serves build/offline.html at /offline.html, with
  /offline.html.sha256 beside it, to any origin
  (`Access-Control-Allow-Origin: *`, the ETag, the file's SHA-256,
  exposed, `Cache-Control: no-cache`, 304 on a match). It builds the file
  itself in the background when it is missing or names another tree's key
  (dist/build.json and every other file the build reads,
  scripts/offline-key.mjs), so a deploy that copies only dist/ serves the
  current one; until then it answers 503 with Retry-After.
  STOMP_OFFLINE_FILE puts the file elsewhere. The home page's Download,
  left of Fork us on GitHub, fetches it and saves it as offline.html with
  the page's direct wisp server written in, so a copy saved from a
  deployment with its own wisp server (STOMP_WISP_URL, a host's config)
  tunnels through that one; never the Tor relay, which the file has no mode
  for. A host that vendors the page names where to fetch it as
  `STOMP_ASSETS.offline`, a URL of any origin or a name under the
  controller's directory; a sandboxed frame of the page saves only with
  `allow-downloads`. Download is hidden below 480 px and in the file
  itself. demo/README.md "offline.html" lists what the file cannot do yet
  (no synchronous XMLHttpRequest, site pool or isolation, among others).
  The offline-html suite opens the build's file from file: through the
  run's wisp server, checks /offline.html, a server that builds it itself,
  Download from this origin and another, with Tor on and in a sandboxed
  frame, and opens a saved copy.
