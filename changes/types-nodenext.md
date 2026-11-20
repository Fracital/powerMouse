### Build

- The declarations in `dist/types` work in a TypeScript project whose
  `moduleResolution` is `nodenext` or `node16`: every relative import in
  them names its file (`./config.js`, `./http3/Http3Transport.js`), given by
  `scripts/types-extensions.mjs` after tsc's emit in `npm run build`. Before,
  such a project got 35 TS2834 errors, or with `skipLibCheck` read every type
  behind those imports as `any`. `npm run check:types`
  (`scripts/check-types.mjs`, a CI step after the build) compiles a consumer
  file that imports `@sysce/stomp`, `@sysce/stomp/path` and
  `@sysce/stomp/omnibox` through the
  package's exports, declarations checked, under `nodenext`, `node16` and
  `bundler`. Under `nodenext` and `node16`,
  `@mercuryworkshop/proxy-transports` 1.0.2's own declarations still import
  their siblings without an extension, so `ProxyTransport` reads as `any`
  there; the check reports those errors apart and does not fail on them.
- The package exports the types `SiteShields`, `ShieldsMode`, `Shields`,
  `SitePoolInit`, `RemoteRequestEvent`, `RemotePermissionRequest`,
  `RequestErrorKind` and `ShardsOption`, which its options, members and
  events were already typed with.
- The `@internal` tag meant for `cookieJar` (the helper behind
  `controller.cookies`) had been left above `passkeyManager`, so the
  declarations had `cookieJar` and lacked `passkeyManager`. The tag is on
  `cookieJar` now, and `passkeyManager` is declared.

### Docs

- The `cache` option's JSDoc says what docs/http-cache.md measures: the
  worker's HTTP cache keeps and asks the origin as Chrome's does, a response
  without `max-age` or `Expires` kept by the Last-Modified heuristic, a
  request's cache mode and a reload of the host's tab honoured, a 206 kept
  as a part, an entry confirmed before a request with other credentials
  gets it. It said only responses with explicit freshness were kept.
