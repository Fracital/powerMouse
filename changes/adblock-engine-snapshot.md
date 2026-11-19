### Fixes

- A first visit (no engine stored yet, or cleared site data) is filtered
  from its first page with the content blocker on by default: the service
  worker loads an engine snapshot of uBlock Origin's six lists that the
  build ships beside it (`adblock-snapshot.dat.gz`, 1.1 MB, gzipped in
  the file and decompressed by the worker so no host needs to compress it,
  and asked for by its hash so a host can serve it `immutable`), and a
  navigation waits for that alone, a second at the most, then loads
  unfiltered if it cannot be had. The eight default lists are still fetched
  after the first page and replace it once built. The first visit's first
  page loaded unfiltered and stayed so for as long as it was open, since a
  scriptlet runs before the page's first script or never: a YouTube watch
  page played the pre-roll ads of every related video it went on to,
  because its player fetches the next video's data (`get_watch`) with a
  `fetch` it took from a frame of its own, which uBlock Origin's
  `trusted-prevent-dom-bypass` hands back only when it ran. A host that
  names the `adblock` option still waits for its lists, five seconds at the
  most. `scripts/adblock-snapshot.mjs` makes the snapshot, the build
  refuses one made by another `blocker.wasm`, and the nightly workflow
  fails while its lists are more than 14 days old. The `adblock` suite
  checks it with a player-shaped page (`adblock-yt-spa.html`) and a
  snapshot of a fixture list.
