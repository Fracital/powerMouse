### Docs

- README's API tables follow the code: the `rewriter` option is gone (the
  rewriter is `core.wasm` and the controller always loads it), the helper
  names are minted per origin and kept in its localStorage (`DEFAULT_NAMES`
  are only fallbacks), the rewrite cache keeps 3000 entries of up to 48 MiB
  and 512 MiB in all, `register()` and the constructor default to the
  calling script's directory, `route()` and `unroute()` resolve to their
  URL, isolated documents carry `frame-ancestors 'self' <host>`, the
  `request` event fires only with `onRequest` set, a `RemoteController`'s
  `onHookError` gets the info alone, and an address with no live controller
  on its directory reaches the host's server after the worker's 3 s wait.
  The tables add `injectDocumentFull` and `injectWorkerFull`, `sandbox`,
  `frameAncestors`, `debugTransport`, `carrierHost`, `webTransport`,
  `onPermissionRequest`, `passkeys`, `shields` and `onShieldsChange`,
  `adblockLists` and the list methods, `sitePool`, `forgetStorage()`,
  `carrier`, `isReady`, `siteMode`, `RemoteFrame.refresh()` and every event
  of both controllers, and the assets list says what `adblockSnapshot` and
  `omnibox` are.
- README says the pinned epoxy build carries WebSocket frames both ways
  (epoxy-tls 0061), and its install commands pin with `-E` and install that
  build by reading the nightly's `devDependencies` with `npm view`.
- AGENTS.md says the rewriter is the wasm core with no JavaScript parser
  (the `rewriter: 'wasm'` and `src/rewriterLib.ts` it named are gone), that
  `package.json` pins epoxy by a `github:` spec, and that the uptime
  check's `cf-cache-status` test never fires with Cloudflare's proxy off;
  deploy.yml's verify comment no longer puts Cloudflare in front.
