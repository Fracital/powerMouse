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

- `npm run dev` is a live-reload development loop: esbuild watch plus the
  demo server in one command, a `/__dev` WebSocket that reconnects forever,
  stylesheets swapped in place, inject rebuilds reloading the proxied frames,
  service worker rebuilds applied through `registration.update()` without a
  page reload (same-origin mode), server restarts and host-page bundles
  reloading the page, and an esbuild error overlay. Development only
  (`STOMP_DEV`).
- `onRequest` on both controllers reports every proxied request (real URL,
  method, destination, status, time, cache hit, size, error) with the frame
  it belongs to, for request viewers; costs nothing when unset.
- `controller.cookies` lets the host read the Cookie header the proxy would
  send, import Set-Cookie values, export cookies as records and wipe an
  origin or everything; host-only by construction.
- An opt-in HTTP cache in the service worker (`cache: true`, `?cache` in the
  demo): GET/HEAD responses with explicit freshness (max-age, s-maxage,
  Expires) are served from a Cache API store, revalidated with ETag /
  Last-Modified when stale, never stored for requests with Authorization or
  cookies (unless `public`), no-store / private / no-cache or Vary: *, and
  capped at 5 MB per entry and 50 MB in all; `controller.clearCache()` drops
  it.
- Frames dispatch a `navigate` event (and controllers take `onNavigate`)
  whenever the proxied page loads, changes its URL through pushState /
  hashchange or changes its title, with whether its own history can step;
  the controller-frame poll is now a fallback (`pollInterval: 0` disables
  it).
- `onOpen(url, frame)` on `StompController` and `RemoteController`: a proxied
  page's `window.open`, `target="_blank"` and named-target or modifier clicks
  become a callback to the host, which opens them in its own tab model; the
  page's `window.open` returns `null`, like a popup blocker. The request is
  posted through the top window's native `postMessage` captured before any
  page code ran, and the host accepts it only from its own frames on the
  proxy origin. Without `onOpen`, popups open natively as before. The demo
  opens them as switcher tabs.
- `Frame` gained `back()`, `forward()` and `reload()`. `back()` and
  `forward()` step the frame's own session history (Navigation API) and
  resolve to whether a step was possible; `canGoBack` / `canGoForward`
  report the same ahead of time.
- `npm test` runs the browser suites in `test/` (Playwright on the system
  Chrome): the demo end to end, Back and history walking, the tab switcher,
  origin isolation, frame-escape vectors in both modes, and runtime-inserted
  script rewriting. Each suite gets its own demo server and fixture on free
  ports; four run at once by default.
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

- A build mismatch at the handshake heals itself instead of rejecting
  `wait()`: after a deploy the page loads the new controller bundle while the
  old service worker is still the active one, so the controller now updates
  the registration, waits for the new worker to activate, binds to it
  (`controller.rebind(worker?)`, public) and shakes hands again; `wait()`
  rejects with the mismatch message only when the builds still differ after
  that or no new worker arrives within 15 seconds. A worker that activates
  later while the page is open is adopted the same way (`updatefound`,
  `controllerchange`), so a deploy no longer needs a hard reload.
- `allowInvalidJs` on both controllers (default `true`, today's behaviour): a
  script the rewriter cannot parse runs as it was. With `false` it fails with
  a `SyntaxError` naming the rewriter error instead, so a broken rewrite is
  loud while developing (scramjet's dev preset does the same).
- `debugger` statements are removed from proxied scripts: on a proxied site
  they are an anti-debugging trap, not the user's breakpoint.
- `npm test` includes a node-side suite (`rewriter-unit`) that bundles the
  JS rewriter with esbuild and asserts the generated code itself; it skips
  with a message where esbuild is not installed.
- A dynamic `import()` in a classic external script resolves against the
  script's URL instead of the document's, and modules get
  `import.meta.resolve()` (the page's URLs; a bare specifier comes back as it
  is).
- Destructuring reaches the spoof at every depth: `const { a: { top } } = o`
  and `({ a: { location: l } } = o)` resolve through the wrapped source like
  the shallow form did, and a destructured parameter
  (`function f({ top: t }) {}`, arrows, methods, with or without a default)
  becomes a plain parameter whose pattern is declared at the top of the body
  and wrapped the same way. Array patterns (`const [{ top }] = [w]`) and a
  nested default (`{ a: { top } = w }`) still read the real value.
- A page's own `history` is scoped to its frame: `length` counts the frame's
  entries instead of the joint session history of the host page and every
  frame in it, and `back()`, `forward()` and `go()` step those entries only
  (Navigation API); a step past either end does nothing, as on a top-level
  page, instead of handing the traversal to the host or a sibling frame.
- A page that calls `document.open()` keeps the window hooks: the message
  filter and tagger, the link and navigate listeners are registered again,
  as they already were after the open that writes the page. The tagger that
  unwraps messages from other Stomp windows is also registered at install.
- Request bodies stream to the transport instead of being buffered in the
  service worker.
- The controller, the service worker and the inject bundles carry a build
  id; a mismatch (a stale bundle next to a new service worker) rejects
  `controller.wait()` with both ids and logs one error in the page, instead
  of failing somewhere else later.
- Response headers that would bind a page to the proxy origin (HSTS,
  `Clear-Site-Data`, COEP, reporting, `Permissions-Policy`, nosniff) and the
  already consumed `Set-Cookie` are stripped; `Link` preloads and
  `Content-Location` are rewritten; requests carry `Origin`, a
  default-policy referrer and fetch metadata computed for the real origins;
  EventSource responses get their MIME type.
- `BroadcastChannel` names, Cache API caches and the origin private file
  system are partitioned by proxied origin.
- `storage` events fire in the other documents of a proxied origin when
  localStorage changes (never in the writer, never across origins).
- Workers started from `blob:` URLs, module workers, `SharedWorker` and
  `Worklet.addModule` work through the proxy; module workers lost their
  inject to a missing `importScripts`, and blob workers could not be read by
  the service worker.
- Frameworks that read the DOM back see what the page wrote:
  `getAttributeNames`, `hasAttribute`, `Element.attributes` and `Attr.value`
  hide the proxy's marker attributes, `innerHTML` / `outerHTML` serialise the
  page's own URLs, and attribute selectors (`a[href^="/"]`) match the page's
  values. `setAttributeNS`, `toggleAttribute`, `setAttributeNode`, SVG
  `href` / `xlink:href` and nodes from `DOMParser` or
  `createContextualFragment` are routed like everything else.
- Rules added with `insertRule`, constructable stylesheets (`replace` /
  `replaceSync`, `adoptedStyleSheets`) and `FontFace` sources are rewritten;
  CSS-in-JS and font loaders fetched from the proxy origin. The text of a
  `<style>` element is rewritten before the browser parses it, so its
  `@import` and fonts are never requested unrouted first.
- Destructuring an unforgeable (`const { top: t } = window`,
  `({ top: t } = window)`) resolves to the spoofed value; `document.location
= url` is routed like `window.location`; `opener` is null unless another
  proxied page opened the window, and `opener.top` can no longer reach the
  host.
- Inline event handler attributes, `javascript:` URLs and string arguments
  to `setTimeout` / `setInterval` are rewritten (they ran unrewritten and
  could reach the real `top`); `<iframe srcdoc>` documents are injected and
  rewritten like fetched ones; `target=_top` / `_parent` (and `formtarget`
  and `window.open` targets) navigate the proxied frame itself, as a
  top-level page would, instead of being refused by the sandbox.
- Inline module scripts carried their original text next to the rewritten
  one (the `text` setter hook removed children while iterating the live
  list) and lost their `currentScript` preamble to a null, so any module
  with an import binding failed to parse.
- Bare import specifiers (`import x from "react"`) are left to the page's
  import map instead of throwing in `new URL`; `export ... from` sources are
  rewritten; the rewriter's identifier skip list covers class fields, catch
  parameters, class expression names, labels, `typeof`, import bindings,
  for-in/of targets and alias destructuring; `{location}` shorthand prints
  the rewrite. A script the rewriter cannot parse now runs as written with a
  console warning instead of becoming `throw new SyntaxError` (see known
  limitations).
- Cookie `Max-Age` is seconds, not milliseconds, and `Max-Age=0` deletes; a
  re-set that flips a cookie between session and persistent replaces it.
- `<template>` contents survive loading (`cloneRawNode` read `childNodes`,
  which is empty for templates).
- Documents are decoded with their declared charset (BOM, `Content-Type`,
  `<meta charset>` prescan) before rewriting and served as UTF-8; Shift_JIS,
  windows-1252 and UTF-16 pages were mojibake.
- `location.reload` exists on the location proxy; `IDBDatabase.name` reports
  the page's name rather than the tail of `name@origin`.
- `npm test` runs every suite at once by default (`PARALLEL` defaults to the
  core count) and splits the Back walk and escape suites into independent
  parts; a fixture-based Back walk (`backwalk-fixture`) covers the same steps
  as the Wikipedia walk without network.
- epoxy comes from `deploy/epoxy/`: pinned upstream revisions plus patches
  (hyper-util-wasm exposes the HTTP/2 header-list limit, epoxy-tls sets it to
  256 KiB like Chrome instead of hyper's 16 KiB default, which reset YouTube
  and other header-heavy sites with `PROTOCOL_ERROR`), built in a container
  and published to the `dist` branches of `Fracital/epoxy-tls` and
  `Fracital/EpoxyTransport`, from which `package.json` installs it. No Rust
  toolchain is needed to install.
- The synchronous bridge throws a `QuotaExceededError` at once when the
  browser refuses its beacon (payloads over 64 KiB, such as a large
  `localStorage.setItem`), instead of spinning until the wall-clock limit
  and freezing the page for seconds per call (Wikipedia's module cache
  triggered this on every navigation).
- The demo's Back button could walk the browser out of the demo page, or
  bounce between the home screen and the last page: the per-tab history list
  over-counted redirected and replaced URLs, so `history.back()` ran at the
  frame's first entry, and Back on the home screen re-entered the tab. The
  frame is now the authority on whether it can step, presses queue up one
  step at a time, and Back on the home screen does nothing.
- Nested frames were given the codec _name_ instead of the codec key when
  their client was created. They now reuse the parent's key.
- In origin-isolation mode the `frame-ancestors` policy only named the host,
  so a proxied page's own iframes (also on the proxy origin) were blocked.
  The policy now includes `'self'`.
- Setting `textContent` on a Text or Comment node threw
  `append is not a function` (the hook assumed an element); the native setter
  now handles nodes without children. Seen on YouTube.
- `data:` script URLs were rewritten without percent-decoding the body, so
  Reddit's `data:text/javascript,%7B...` scripts became `SyntaxError: Unexpected
token '%'`. The body is decoded before rewriting and re-encoded after.
- The synchronous cookie/storage bridge never worked in origin-isolation
  mode: the service worker answers through `cookieStore.set`, whose default
  `SameSite=Strict` is invisible to `document.cookie` in a proxied frame (a
  cross-site embed of the proxy origin), so every `document.cookie` and
  `localStorage` call spun until its limit and threw. The answer cookies are
  now `SameSite=None`. The spin limit was also a fixed cycle count (about a
  second) and is now wall-clock, 10 s for loopback routes, so a service worker
  busy rewriting a large script (YouTube's main bundle takes over two seconds)
  no longer makes `document.cookie` throw.
- Inline styles: the `style` attribute hook re-wrote the browser's own
  serialization of the text it had just written (Polymer assigns the changed
  attribute back to `el.style` from `attributeChangedCallback`), flipping the
  attribute between the original and the rewritten text until the stack
  overflowed; YouTube froze a few seconds after rendering. The hook now
  recognises the echo. The generic property setter also re-assigned
  `el.style = el.style` after a write, which `PutForwards=cssText` turns into
  `"[object CSSStyleDeclaration]"` and wipes the inline style; the re-assign
  is skipped when the getter does not return a string.
- Inline scripts that a page inserts at runtime (`script.textContent = ...`
  then `append`, `innerHTML` / `insertAdjacentHTML` with a `<script>`, a
  text node appended to a script) ran unrewritten: the insertion hook skipped
  scripts that were not connected yet, which at insertion time is every one
  of them. They saw the proxy URL in `location` and reached the real `top`.
  Scripts are now rewritten when the tree they land in is connected, once per
  element.
- `top.location = x` (and `top[k] = x`, `top.location ||= x`) handed the
  rewriter's `set2` the real `top` instead of the spoofed one, so in
  same-origin mode it navigated the host page to the unproxied URL. The
  assignment target is now rewritten like reads and calls are.
- Same-origin `Frame`s had no `sandbox`, so `<a target="_top">`,
  `<a target="_parent">`, `<form target="_top">` and
  `window.open(url, '_top')` on a proxied page replaced the host page with
  the proxied one (reproduced on the demo). `StompController` now applies
  `DEFAULT_SANDBOX` to every frame it creates; `sandbox: null` in
  `ControllerInit` opts out. This is hardening, not a security boundary:
  same-origin frames can still reach the host DOM, and Chrome warns that a
  sandbox with both `allow-scripts` and `allow-same-origin` can be escaped.
- The demo's tab switcher expanded a card to the full stage (top of the
  viewport, above the navigation bar) while the frame rests below the
  address bar, so the page jumped down by the bar's height and the iframe was
  resized when the stage went away. A card is now a scaled preview of the
  whole browser view, address bar included (the tab's URL and title in the
  bar's own styles), and expanding it is one transform of that block: the
  bar copy lands on the real bar and the frame on its resting box. The
  browser view also leaves room for the navigation bar instead of hiding the
  bottom of every page under it, and the dock buttons fade out when a tab is
  opened from a switcher that was entered from the home screen (they used to
  stay put and vanish).
- The demo prints its deployment facts (mode and origins, transport and wisp
  endpoint, version, controller state, boot errors) as styled console badges
  instead of showing the isolation mode on the landing page.

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

- Aborting a fetch does not cancel the request on the transport (epoxy
  ignores the signal); the response is discarded.
- The HTTP cache never serves stale on a failed revalidation and uses no
  heuristic freshness.
- The page's own `Referrer-Policy` is not applied; requests follow
  `strict-origin-when-cross-origin`.
- `href.baseVal` on SVG elements and `getSVGDocument()` are not spoofed;
  `script.textContent` returns the rewritten source for scripts the page
  inserted itself.
- `getComputedStyle` / `getPropertyValue` return routed `url()` values;
  `CSSRule.cssText` assignment and the Typed OM are not rewritten.
- Array destructuring patterns (`const [{ top }] = [w]`) and a nested
  pattern's default value (`{ a: { top } = w }`) still read the real value.
- In same-origin mode a `postMessage` from the host into a frame runs the
  frame's own hooked `postMessage`, so it arrives as if the page had sent it;
  only the cross-origin boundary of isolation mode lets the filter drop it.
- A script the rewriter cannot parse runs unrewritten (unless
  `allowInvalidJs: false`). In isolation mode the
  sandbox and the cross-origin boundary contain it; in same-origin mode it can
  reach the real `top`, which is one more reason that mode is not a security
  boundary.
- The code of a `blob:` worker runs with the worker hooks but is not itself
  rewritten; worklet modules get no inject.
- Transports, as tested against `wisp-js` 0.5.2 with or without Stomp in the
  path: epoxy 3.0.2 handles HTTP well but stops delivering incoming WebSocket
  frames after the first round trip; libcurl 2.0.6 handles WebSockets but
  stops answering HTTP after roughly 70 requests with its default pool and
  roughly 160 with a larger one, which breaks any page that fans out that many
  assets. The demo defaults to epoxy and raises libcurl's pool when selected.
- The published epoxy-transport (hyper's HTTP/2 client) resets any response
  whose header block is larger than 16 KiB with `PROTOCOL_ERROR`, and its
  `header_limit` option does not change that. YouTube answers a
  `HeadlessChrome` user agent with a 7 KB `connection-allowlist-report-only`
  header on top of its 6 KB CSP report, a 20 KB block. This project installs
  the Fracital fork (256 KiB, Chrome parity) instead, so YouTube renders here;
  anything still on the npm package, Fracital included, hits it.
- Import maps are passed through untouched: bare specifiers are left to the
  page's map, but the map's own URLs are not rewritten.
- Synchronous XMLHttpRequest and the synchronous storage/cookie bridge spin
  the page's main thread while waiting on the service worker. With the
  transport hosted in the same renderer, a synchronous request that needs the
  network deadlocks until the spin limit (30 s); loopback requests wait up to
  10 s, which covers the service worker rewriting a 10 MB script. The answer
  travels in `SameSite=None` cookies, so in origin-isolation mode the bridge
  needs third-party cookies allowed for the proxy origin.
- Still unproxied or unspoofed: `self.location` inside workers, scripts
  written into a child frame with `document.write`, and `a.pathname` on
  anchors (reports the page's path).
- Without `onOpen`, `_blank` and named targets open the proxied page in a
  bare new tab outside the host application (the frame sandbox keeps
  `allow-popups`).
