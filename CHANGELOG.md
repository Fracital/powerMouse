# Changelog

## 2.0.0

The first release after a four-year gap. Everything below is breaking.

### Build

- webpack and swc-loader are replaced by esbuild (`build.js`). Type checking
  (`tsc --noEmit`) and lint (eslint 10, flat config) run as separate scripts.
- Bundles that expose a classic-script global now define it with
  `Reflect.defineProperty` so it stays configurable.
- An ESM entry (`dist/controller.mjs`) with declarations is published as the
  package main; `stomp-rewrite/path` keeps exporting `stompPath`.

### Transport

- `@tomphttp/bare-client` and the `bareServer` config option are gone. Traffic
  goes through a `@mercuryworkshop/proxy-transports` transport.
- The transport is owned by a `StompController` in the host page. The service
  worker and every proxied document and worker reach it over MessagePorts
  (`src/transport/`), so a page never needs the transport module itself.
- Proxied content lives in frames (`controller.createFrame().go(url)`). The old
  `Bootstrapper.navigate()`, which navigated the top-level page, is removed
  because nothing would host the transport afterwards.
- The service worker is registered by the host and no longer takes
  `?config=` on its URL; configuration arrives with the controller handshake.
  The `/process` and `/client` routes are removed.
- `Set-Cookie` headers on WebSocket handshakes are no longer applied to the
  page: proxy-transports does not expose them.

### Demo and API

- `Frame` gained `back()`, `forward()` and `reload()`.
- The demo is a Powermouse-styled host application: landing page with quick
  links, tabs (one `Frame` each) with an address bar that tracks the real
  URL, a transport switch, and an early-Android style navigation bar with a
  tab manager. `demo/README.md` walks through how it uses the API.

### CI

- GitHub Actions workflow (lint, types, format, prose, build) on pushes and
  pull requests with a read-only token, pinned actions, install scripts
  disabled and no write-back; dependabot for actions and npm;
  `npm run check:prose` enforces the no-em-dash and no-AI-attribution rules.

### Deployment

- The demo is live at https://stomp.fracit.al: `.github/workflows/deploy.yml`
  builds every push to `master` and has terp run `deploy/terp-deploy-gate.sh`
  (stage build, swap, pm2 restart, health check, rollback). The demo server
  reads `PORT`, `STOMP_WISP_URL` and `STOMP_PROXY_ORIGIN` from the environment
  or a `.env` file and hands the page its settings through `/config.js`; with
  an external wisp URL the built-in `/wisp/` is not served. See
  `demo/README.md`, "Deploying somewhere real".

### Dependencies

- meriyah 7, parse5 8, css-tree 3, entities 9, idb 8, set-cookie-parser 3,
  ast-types 0.16, crypto-js 4.2.
- `effective-domain-name-parser` is replaced by `tldts`; `sameHost` now
  compares registrable domains rather than second-level labels.
- `meriyah-loose` (a 4.x fork) is dropped; scripts that fail to parse are
  rewritten to `throw new SyntaxError(...)` as before.

### Fixes

- Nested frames were given the codec _name_ instead of the codec key when
  their client was created. They now reuse the parent's key.

### Origin isolation

- `RemoteController` / `RemoteFrame`: the host page embeds
  `dist/controllerFrame.html` from a separate proxy origin; that frame
  registers the service worker, loads the transport and runs the real
  controller, driven over `postMessage` with origin checks.
- Proxied content lives in sandboxed, cross-origin frames (no
  `allow-top-navigation`), and the service worker emits
  `Content-Security-Policy: frame-ancestors <host>` on proxied documents.
- Framing spoof (`src/inject/dom/modules/Framing.ts`): `frameElement` is
  null, `window.name` is a shadow value, outer size and screen position
  match the inner size, `document.referrer` never reveals the host,
  `location.ancestorOrigins` is empty, and `message` events from outside
  the proxied world are dropped. `top` and `parent` resolve to the page
  itself across a cross-origin parent.
- Transports are described (`{ module, options }`) rather than passed as
  instances in isolation mode. The demo runs isolated on
  `localhost` (host) vs `127.0.0.1` (proxy).

### QA pass (headless Chrome against the demo)

Fixed while testing real sites and a feature fixture:

- `window.top` inside a proxied frame now resolves to the outermost proxied
  context instead of the host page (`top` is unforgeable, so this goes through
  the JS access rewrite).
- `document.cookie` no longer exposes `HttpOnly` cookies.
- `history.pushState` with a fragment no longer doubles the hash.
- `@import "file.css"` (string form) is rewritten; only `url()` was before.
- `Referer` and `Origin` are rebuilt from the proxied referrer; the service
  worker never sees the browser's own copies.
- Forms submitted to an `action` set after `method` no longer post to the
  page itself.
- `EventSource` could not be constructed.
- Inline scripts whose rewritten code contained `</script` ended the element
  early; inline `type="module"` scripts were rewritten with the script goal.
- Optional chaining through a computed member (`a?.[k]`, `a?.[k]()`) kept its
  short-circuit semantics only in the generated text, not at runtime.
- Custom element reactions ran while the element still had Stomp's hook
  prototype (`this._$AK is not a function` on Lit sites).
- URLs inside inline styles were never rewritten: `style="..."` on any element,
  `element.style.x = ...`, `style.setProperty`, `style.cssText`, CSS custom
  properties (`--x: url(...)`) and `insertAdjacentHTML` all leaked the real
  origin. Reads give the page back its own value.
- `<script src>` is re-routed when `type="module"` is set after `src`.

### Known limitations

- Workers created from `blob:` URLs are routed through the service worker,
  which cannot read a page's blob URLs; such workers fail to start. Workers
  loaded over HTTP work, including WebSockets from inside them.
- Transports, as tested against `wisp-js` 0.5.2 with or without Stomp in the
  path: epoxy 3.0.2 handles HTTP well but stops delivering incoming WebSocket
  frames after the first round trip; libcurl 2.0.6 handles WebSockets but
  stops answering HTTP after roughly 70 requests with its default pool and
  roughly 160 with a larger one, which breaks any page that fans out that many
  assets. The demo defaults to epoxy and raises libcurl's pool when selected.
- Import maps are not supported: bare specifiers (`import "react"`) are
  resolved against the module URL.
- Synchronous XMLHttpRequest and the synchronous storage/cookie bridge spin
  the page's main thread while waiting on the service worker. With the
  transport hosted in the same renderer, a synchronous request that needs the
  network deadlocks until the spin limit; loopback requests still work but
  can time out when the service worker is busy rewriting.
- Still unproxied or unspoofed: `self.location` inside workers, inline event
  handler attributes (`onclick="..."`), scripts written into a child frame
  with `document.write`, `document.referrer` (reports the host page), and
  `a.pathname` on anchors (reports the page's path).
