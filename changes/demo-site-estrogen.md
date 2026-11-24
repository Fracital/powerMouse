### Demo and API

- `npm run build:demo-site` copies everything the demo serves from files
  (demo/public, dist without its maps and declarations, the transports,
  tor-js, the examples) into build/demo-site and runs estrogen over it, then
  a leak gate: every served file is searched for the names that say what the
  site is (derived from the source, scripts/demo-canaries.mjs) as written,
  base64- and percent-encoded and gzipped, and every script must run in
  estrogen's VM. `STOMP_DEMO_SITE=build/demo-site` serves it. The protected
  build uses neutral asset and route names and a Browser manifest, while the
  checkout's demo and the package API keep their names. Its gate passes with
  every script in the VM, and the planted-leak self-check still fails closed.
  The protected server answers with no repository commit history either.
