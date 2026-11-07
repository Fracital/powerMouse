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

- `names` on `StompController` and `RemoteController`: the four global names
  the rewriter and the inject bundles use (`access` for the API every
  rewritten script calls, `client` for the client on the window, `globalProxy`
  and `globalName` for the markers on the `location` and `eval` stand-ins;
  defaults `$s$j`, `$P$s`, `$s$L`, `$s$N`) can be a deployment's own. They
  travel in the config: the worker rewrites with them, the shell hands them to
  the inject, and about:blank children and workers inherit them. A name that
  is not an identifier, a reserved or special word, a global a plain window
  has, used twice, or an unknown key is a `TypeError` from the constructor.
  `DEFAULT_NAMES` and the `HelperNames` type are exported (helper-names
  suite, a StompController and a RemoteController built with random names;
  the tells fixture takes the names to look for).
  suite; the tells fixture takes the names to look for).
- Several controllers share one directory: two host tabs on `/stomp/` no
  longer replace each other in the service worker. Every `StompController`
  (and `RemoteController`) has an id (`init.id`, 1 to 32 characters of
  `[A-Za-z0-9_-]`, 8 random ones by default, read back as `controller.id`)
  and its routed URLs carry it: `/stomp/<id>/html/<encoded>` where they were
  `/stomp/html/<encoded>`. `config.directory` is that address and the new
  `config.scope` the directory the host gave (`controller.directory` still
  means that); only the asset URLs (the inject bundles, the transport
  worker, the controller frame) are built from the scope. The same id passed
  again replaces, as before; a host that keeps tabs stores one id per tab
  (sessionStorage) and passes it back, so the tab's history entries,
  reloads and copied links keep resolving. A controller is a tab, not a
  browser: the cookie jar, the HTTP cache and the storage partitions are
  per scope and shared by its controllers, and sessionStorage is cleared
  once per scope per worker lifetime, where every new server cleared it
  before. A routed URL whose controller is gone (a closed tab, a stale
  link) is redirected to the newest live controller of the scope with the
  same codec; with none, the host's error page answers with kind
  `controller` (a new value of the request log's `kind`). A URL of the
  old shape (`/stomp/html/<encoded>`, a tab or bookmark from before this
  change) is redirected to the newest live controller too. The worker also
  answers the inject bundles and the transport worker under an address
  (`/stomp/<id>/injectDocument.js`, a redirect to the scope's file), so a
  worker of the previous build serving a page for a new controller still
  gets its page a working inject. A replaced controller's calls reject with
  "Controller replaced", and a request on a transport port whose other side
  is gone fails at once instead of waiting out the worker's timeout. The
  multi-controller suite covers it, including the first controller still
  navigating after the second registered.
- The transport can run off the host page's thread. `StompController` takes
  a `TransportDescriptor` (`{ module, options }`, what `RemoteController`
  already took) in place of a ProxyTransport instance and starts it in a
  dedicated Worker (`dist/transportWorker.js`, the `transportWorker` asset,
  served from the directory like the rest); the service worker and every
  proxied page reach the transport over ports the worker serves, and the
  WebSocket handshake cookies stay with the controller, which the worker asks
  for them. A proxied frame's synchronous XMLHttpRequest that needs the
  network now completes in same-origin mode (it spun the main thread for
  the 30 s limit while the transport shared it; measured: status 0 after
  30.0 s before, 200 after). `host: 'page'` on the descriptor keeps the
  import in the page, and an instance is served from the page as before.
  `controller.transportHost` says which (`worker` or `page`); when the worker
  cannot start or the module cannot be imported there, the page imports it
  instead and a `transporthost` event (`detail: { host: 'page', error }`)
  says so, never a dead controller. `setTransport()` takes a descriptor on a
  worker host (the swap is a message to the worker; in-flight requests finish
  on the old transport) and an instance on a page host, a TypeError
  otherwise. The controller frame hosts its worker the same way, so
  `RemoteController` gets it for free. The `transport-worker` suite covers
  the boot, the sync XHR, a swap from epoxy to libcurl, both fallbacks and a
  page WebSocket served from the worker.
  The demo and the example host pass a descriptor, so their proxied pages
  get the worker-hosted transport; the dev loop reloads the page when
  `transportWorker.js` rebuilds.
- `npm run dev` is a live-reload development loop: esbuild watch plus the
  demo server in one command, a `/__dev` WebSocket that reconnects forever,
  stylesheets swapped in place, inject rebuilds reloading the proxied frames,
  service worker rebuilds applied through `registration.update()` without a
  page reload (same-origin mode), server restarts and host-page bundles
  reloading the page, and an esbuild error overlay. Development only
  (`STOMP_DEV`).
- test: scramjet's adversarial corpus ported as a measurement (`adversarial-*`
  suites over `test/pages/adv-*.html`): 682 probes per mode across nine
  groups run inside a proxied page in both demo modes; 93 reach the host
  window, a proxy URL or a proxy fingerprint and are recorded, not fixed (see
  the parity doc's corpus row).
- `examples/minimal-host.html` is the smallest host application (same-origin
  `StompController` on epoxy, one frame, the three callbacks), served by the
  demo at `/examples/`; README "Embedding" walks through it, and the new
  `host-api` suite runs the host API checklist against it.
- The demo has a request viewer: long-press Recents or Ctrl+Shift+R slides
  up a panel with the active tab's proxied requests (method, status, real
  URL, destination, time, size, a `cached` tag), built from the controller's
  `onRequest`; the HTTP cache is on in the demo and `?nocache` turns it off.
- `onRequest` on both controllers reports every proxied request (real URL,
  method, destination, status, time, cache hit, size, error) with the frame
  it belongs to, for request viewers; costs nothing when unset.
- `controller.cookies` lets the host read the Cookie header the proxy would
  send, import Set-Cookie values, export cookies as records and wipe an
  origin or everything; host-only by construction.
- An HTTP cache in the service worker, on by default (`cache: false` turns
  it off, `?nocache` in the demo): GET/HEAD responses with explicit freshness (max-age, s-maxage,
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
- `frame.go()` and `frame.reload()` on both controllers resolve when the new
  document has reported (its URL, title and history state are in), a second
  after the frame's `load` event for a document that never reports (an
  image, a download, a blocked response), 30 seconds at the most; `reload()`
  resolves false when there was nothing to reload. The first report comes at
  document start, before the body is parsed: right for an address bar, too
  early for reading the page's DOM (use the frame's `load` event, listened
  for before `go()`). Both controllers also dispatch `navigate`
  (`detail: { info, frame }`), `open` (`detail: { url, frame }`) and
  `request` (`detail`: the `onRequest` report) as CustomEvents, so handlers
  can be added after construction.
- `onRequest` reports: a subresource fetched before its page has said which
  frame it is in (a head stylesheet or script) waits up to 1.5 s for that
  and carries its frame like the document does; a CSS image is reported
  without the `#url(...)` fragment the CSS rewriter keeps; `destination` is
  `fetch` for fetch, XHR and keepalive beacons (the browser's empty string).
  The document's own report lands after its body was served, often after
  the first fetches of the page.
- `StompController.register(directory?, { assets, updateViaCache })`
  registers the service worker served from the directory (the constructor's
  default when omitted) with `updateViaCache: 'none'` and resolves with the
  registration once its worker is activated, 30 seconds at the most (a worker
  stuck installing never hangs the host). The constructor's `serviceworker`
  accepts that registration (or any `ServiceWorkerRegistration`) in place of
  a worker: it takes the active, waiting or installing one and shakes hands
  once it is activated. The activation helper every host copied from the demo
  is gone from `examples/minimal-host.html`. Both controllers and both frame
  classes keep their state in `#fields`: nothing a page could reach is an own
  property any more (`lastHandshake` stays, the dev loop sets it).
  The demo boots through `register()` too.
- `errorPage` on both controllers: the host's own page for a document the
  proxy itself failed to produce (the transport could not reach the origin,
  the worker's timeout, a routing error, a blocked rule, the refusal to proxy
  its own origin). The worker fetches it from its own origin without the HTTP
  cache, puts `globalThis.stompError = { url, status, error, kind }` in its
  head (escaped so no message can close the script) and answers under the
  frame's routed URL with the failure's status (502 for a transport
  failure, which the request report counts as 0), never cached, so
  `location.reload()` retries the real page (the page is not an injected
  one: `frame.url` reads null for it, the request report names the URL).
  Upstream error pages (a site's own 404) are untouched. In origin-isolation
  mode the path is on the proxy host, where the worker runs. Request reports
  carry the same `kind` next to `error`. `examples/minimal-host.html` uses
  `examples/error.html`. The demo's is `demo/public/error.html`,
  and its request viewer shows a failed document under the tab that asked
  for it, with the failure's kind.
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

- `URL.createObjectURL` answers with the page's origin. A blob: URL names the
  origin of the realm that minted it, which is the proxy's, so every object
  URL a page or worker made (and stored, showed, or compared with
  `new URL(u).origin`) carried the proxy origin: the last proxy-origin leak
  the adversarial corpus could see, hidden until async XHR in workers worked.
  The page now gets `blob:<its origin>/<uuid>` and everything it hands the URL
  to maps it back to the browser's form (every URL-taking API routes through
  `routeURL`, which does it for blob: URLs, plus `fetch`'s direct path, the
  worker bootstrap and `revokeObjectURL`); response URLs and readback show the
  page's form. A blob: URL of another origin is left as it is and does not
  resolve, as the browser refuses blob: URLs across origins (blob-origin suite,
  both modes; adversarial-urls 12 failures to 2, adversarial-workers 2 to 0).
- A rewritten body no longer outlives the worker that made it. Rewritten
  responses (documents, scripts, stylesheets, XHR bodies, the inject shells)
  went out with the origin's caching headers, so the browser's HTTP cache
  could keep a rewritten script for as long as the origin allowed (a year for
  an immutable asset) with an old rewriter's output or old helper names in it;
  a rewriter upgrade did not reach it. They now go out `cache-control:
no-cache` with the origin's validators kept and `expires`/`age` dropped: the
  browser asks the worker again and the worker answers from its own cache of
  the upstream bytes, so a reload revalidates without an upstream request
  (measured: one upstream fetch across a load and a reload). Bodies the worker
  did not rewrite keep the origin's headers (no-cache suite).
- Reflection reaches the same spoof as a member read: `Object.getOwnPropertyDescriptor`
  and `Reflect.getOwnPropertyDescriptor` (and `getOwnPropertyDescriptors`,
  `__lookupGetter__`, `__lookupSetter__`) on a window or the document answer
  descriptors for `top`, `location` and `eval` whose accessors resolve through
  the access API (a location write routes), `Reflect.get` and
  `Object.entries` / `Object.values` resolve those values by what they are
  (so a Proxy over the window is covered), and the access API's own name is
  not enumerable and is left out of `getOwnPropertyNames` / `Reflect.ownKeys`
  of a window. `super.location` is left alone by the rewriter (it was a
  SyntaxError), and a function made with `new Function` reads back the source
  the page gave in the browser's shape. Corpus: protos 36 leaks to 0, eval 6
  to 0, in both modes.
- Scripts a page inserts or writes at runtime run rewritten in more shapes:
  the inline scripts of `document.write` / `writeln` markup; a connected
  script's `text` / `textContent` set after insertion (the moment it runs);
  a JavaScript Blob (`text/javascript` and the other JavaScript MIME types)
  loaded as a script's `src` or imported by a worker, rewritten at
  construction like an HTML blob (as a module when only that parses); a
  script appended to a connected shadow root; and every node argument of
  `append` / `prepend` / `replaceChildren` / `before` / `after` on elements,
  fragments and documents (`append(a, b)` rewrote `a` only). `Attr.value`
  and `nodeValue` writes reach the attribute hooks, a `javascript:`
  destination of `window.open` is rewritten, and `Reflect.set` /
  `Object.assign` with `location` route like an assignment.
- `document.write` / `writeln` markup is tokenized across calls, the way the
  browser's own parser reads it: a tag name, an attribute value, a script or
  style body, a comment or a textarea that one call leaves unfinished waits
  for the call that finishes it (`write('<scr'); write('ipt src=...')`, the
  shape old ad and analytics loaders use), and an element a call leaves open
  holds what the next call writes (`write('<div>'); write('x</div>')` made a
  closed div, loose text and a dropped end tag; an end tag for the element
  the script sits in closes it). Each call used to be parsed as a complete
  fragment, so a split script ran as text or threw, a split URL was lost and
  a split style never applied. `document.close()` hands the parser whatever
  is still pending, as the end of its input would.
- Markup the browser parses itself goes through our parser first:
  `setHTMLUnsafe` on an element or a shadow root (so a declarative
  `<template shadowrootmode>` gets rewritten contents) and a shadow root's
  `innerHTML`, which reads back as the page wrote it. Nodes parsed from a
  markup string stay in the parser's document until they are cloned: an
  `img onerror` from `innerHTML` / `outerHTML` / `insertAdjacentHTML` no
  longer fires once raw before the rewritten handler runs.
- A write to another window's `location` (`frame.contentWindow.location =
url`) carries its value and targets that window. An about:blank child of
  a proxied page runs its creator's bundle, whose free `location` was the
  creator's, so the creator navigated to `undefined`; the Location module
  reads the document's own `location` for the same reason. Corpus: scripts
  51 leaks to 2 in both modes; the 2 are one probe that reports the window
  `window.open('javascript:')` returns, which is the browser's own result.
- A document a proxied page writes into an about:blank child or popup runs
  its creator's bundle: the attribute hooks now install on that document's
  own element constructors (`HTMLAnchorElement` and twenty others were the
  creator's, so an anchor's `href` in a written child read back routed), and
  its location proxy takes that document's `Location.prototype`. A
  BroadcastChannel message's `origin` is the page's origin, not the proxy's.
  Corpus: frames 8 failing checks to 4 and messages 5 to 2 in both modes;
  the remaining ones report the browser's own results (a window returned by
  `window.open('about:blank')`, a probe's own source text serialised by
  `innerHTML`, a sloppy-mode detached method call that does not throw).
- A meta element's `content` property reads back what the page wrote: the
  hook treated every content as a URL and answered `<proxy>/stomp/html/null`
  for a meta the proxy never rewrote, which broke pages decoding a base64
  payload from one (GitHub's `visitor-payload`, three atob errors per load).
  A rewritten refresh reads back as written too.
- What a page reads back from its stylesheets and markup is what it wrote.
  A rule's `cssText` and `style`, a sheet's `href` (and an `@import`'s), a
  style element's text, rules inserted or constructed at runtime, a style
  attribute the browser serialised from a CSSOM write, and serialised markup
  (`innerHTML`, `outerHTML`, `XMLSerializer`) show the page's url()s and
  attribute values, never the routed ones: the rewriter keeps the written
  url() token after `#url(` and the readback restores it. A template's
  `innerHTML` folds the markers inside its content, `XMLSerializer`
  serialises a folded copy, `getAttributeNS(null, name)` and an attribute
  node's `textContent` answer like `getAttribute`. Corpus: attrs 36 failing
  checks to 2 (MutationObserver records, which show the marker writes;
  scramjet fails that one too).
- What the platform tells a page about itself names the page's URLs. An
  uncaught error's `filename` (`ErrorEvent.filename` and the second argument
  of a `window.onerror` handler) is the script's real URL; the stack of code
  run through `new Function` or `eval` no longer names the inject bundle as
  its eval origin but the page's own call site; a `Response` that came back
  from the Cache API or was cloned reads its real URL. Cache API entries are
  keyed by the page's URLs (a string key resolves against the page, `keys()`
  and matches come back as the page's, `add()` and `addAll()` fetch through
  the proxy); `indexedDB.databases()` lists the page's own databases by their
  own names and no others. Corpus: urls 22 failing checks to 12; the 12 are
  blob: URLs carrying the proxy origin (five probes) and the absent
  `navigator.serviceWorker` (a decision: pages never reach the worker).
- A worker believes it runs where the page put it: `self.location` (every
  URL part and `String(location)`) and `self.origin` are the real script URL
  for a classic or module worker, the same blob under the page's origin for a
  worker started from a blob: URL (its stack frames agree), and a shared
  worker reads its own name back without the origin the constructor hook
  appends to keep proxied origins apart. Like a document's, the stand-in is
  what rewritten code gets from the access API; `WorkerLocation.prototype`
  is untouched, and the reflection hooks treat a worker scope and its
  prototypes like a window (`getOwnPropertyDescriptor(WorkerGlobalScope.prototype,
'location')` resolves to the stand-in, the access API's name is hidden
  from `getOwnPropertyNames(self)`). Corpus: workers 10 failing checks to 0.
- The helper names the rewriter and the inject rely on (`$s$j` and `$P$s` on
  the window, `$s$L` and `$s$N` on the location and eval stand-ins) are not
  visible to a page asking reflectively: `getOwnPropertyNames` and
  `Reflect.ownKeys` leave them out, `hasOwnProperty`, `Object.hasOwn`,
  `Reflect.has` and `propertyIsEnumerable` deny them, on the window, the
  document, location and eval only (a page's own object with such a key
  answers natively). Two tells stay and are documented: the bare `in`
  operator (rewriting every `in` would cost more than it hides) and
  `Error.prepareStackTrace` being a function (stack cleaning needs it;
  scramjet carries the same).
- An optional chain stays optional past an unforgeable link: `a?.b.location.c`
  rewrote to an access-API read that threw on a nullish `a` where the page's
  code short-circuited to undefined. The rewriter now looks down the chain's
  spine for an earlier optional link (a parenthesised chain ends it, as in
  the language) and keeps the rest of the chain optional. `img.currentSrc`
  reads back the candidate the browser picked as the page wrote it.
- The service worker refuses a route that decodes to the proxy's own origin
  (403, "Stomp does not proxy its own origin", reported with `error`): the
  proxy fetching itself was a loop and a way to its host page. A fetch's
  credentials mode reaches the cookie jar the way the browser applies its
  own: `omit` sends no cookies and stores none from the response,
  `same-origin` sends them only when the initiator's real origin is the
  target's, `include` and the default send them.
- The rewriter keeps the two comments DevTools reads: `//# sourceURL=` as
  written (eval'd code and stack frames carry the name the page gave) and
  `//# sourceMappingURL=` routed against the real script URL (a `data:` map
  as it is), appended after the rewritten code; every other comment is still
  dropped with the formatting.
- `navigator.registerProtocolHandler` (and `unregisterProtocolHandler`) is
  accepted and does nothing: it would register the proxy origin, with the
  browser's prompt naming it; a bad scheme still throws. `console.clear()`
  does nothing in pages and workers: the console is shared with the host and
  carries the rewriter's warnings. The Navigation API is kept, with its URLs
  read back unrouted, rather than removed.
- `WebSocketStream` (Chrome) goes through the proxied WebSocket like
  `WebSocket` does: the URL resolves against the page, `opened` hands the
  page its readable (strings and ArrayBuffers) and writable, `closed`
  settles with the close code and reason, `close()` and an aborted `signal`
  close the socket. Only where the browser has the class, so feature
  detection stays truthful; before this a page using it bypassed the proxy.
- A script that opens with `'use strict'` stays strict: the rewriter keeps
  the directive prologue first and places the worker bootstrap and an inline
  script's `currentScript` restore after it. Both came before it, which made
  the directive a plain expression, so inline scripts and classic workers ran
  sloppy (`this` in a plain call was the window, undeclared assignments
  passed). Measured before the fix: inline sloppy, external strict, worker
  sloppy, eval strict.
- Markup written into an about:blank child frame or popup (which runs its
  creator's bundle) produces nodes of the child's own realm and document: the
  clone helper used the bundle's `document`, `DOMParser`, `Text`, `Comment`
  and `Element`, so the child's elements were the creator's and its own
  hooks never saw them. It now works in the client's document and decides by
  node type. The request report for a failure the host's error page answers
  carries no client id (the page never reports one), so the host gets it at
  once instead of after the attribution wait.
- `history.pushState` and `replaceState` refuse a URL of another origin, or
  one that does not parse, with a SecurityError naming the page's origin and
  URL, like the browser; before this the URL was routed and accepted (every
  proxied URL looks same-origin to the browser, so the check is made on the
  real origins).
- A frameset's `<frame>` and an `<object>` hand the page an injected
  `contentWindow` / `contentDocument` like an `<iframe>` does (an about:blank
  frame the page writes into gets the child hooks). An HTML document in an
  `<object>` or `<embed>` still cannot be proxied: Chrome never routes their
  loads through a service worker (measured: no request reaches the worker),
  so the browser fetches the routed URL from the proxy origin directly.
- A frame nested in a proxied page of the same real origin reads its own
  `frameElement` (another origin's parent gives null, the host's frame is
  never seen), and `MessageEvent.source` follows the real origins: a window
  of the page's own origin as it is, another proxied origin's restricted
  (every proxied window shares the proxy origin, so the browser handed the
  page the whole window), anything outside the proxied world as the top.
  Known gap, measured: a same-origin child posting to its parent goes through
  the parent's own `postMessage` wrapper, which makes the parent the
  incumbent, so the browser reports the parent as the source (and the
  envelope the parent's origin); a cross-origin child posts through its own
  realm's wrapper and is reported right.
- `<meta http-equiv="refresh">` and the `Refresh` header are parsed the way
  the browser parses them (whitespace, the time, `;` or `,`, `url` in any
  case with or without `=`, a URL without `url=`, matching quotes dropped)
  instead of a regex that needed a literal `url=`; a bare time or a URL that
  is not http(s) is left alone.
- `XMLHttpRequest` in pages and workers behaves like the browser's where it
  did not: `responseType` `json` gives the parsed value (null when it does
  not parse), `blob` a Blob with the response's type, `document` a Document
  (HTML or XML by content type) and `responseXML` with it, which also comes
  for an XML response under the default type and throws InvalidStateError
  under the other types; the event sequence is `loadstart`, `progress`,
  `load`, `loadend`; `timeout` is implemented (timeout then loadend, status
  0); `abort()` and a failed request end with `loadend`; `upload` exists and
  reports the body sent; `withCredentials` is kept and reaches the jar as
  the credentials mode. Measured against the browser on one page before the
  fix: of eleven shapes none matched; after: all eleven.
- A message posted to another proxied window names its real sender. Every
  `x.postMessage(...)` call (and the `.call`, `.apply` and `Reflect.apply`
  forms) is rewritten to go through the caller's access API, which calls the
  receiver's native `postMessage` from the caller's realm, so the browser
  takes the caller as the incumbent: `event.source` is the sender's window
  and the envelope carries the sender's real origin. Before, a same-origin
  child posting to its parent went through the parent's own wrapper and the
  parent was reported as its own source. Ports, workers, plain objects, a
  restricted window and a `postMessage` the page replaced are called as
  written. Cost: a 10.8 MB YouTube bundle rewrites to 19,269,309 bytes
  instead of 19,268,215 (25 call sites), in the same time.
- Four small corrections of rewritten code: `eval(x)` returns anything that
  is not a string unchanged (it was stringified); the generator and async
  generator function constructors run rewritten code and read back like
  `Function` does; a base64 `data:` body is decoded and encoded as UTF-8 (a
  stylesheet or script with characters beyond Latin-1 was mangled); a
  top-level `var location = url` or `var { location } = o` in a classic
  script, which assigns the window's location, is bound to a temporary and
  routed like `location = url` (it navigated to the proxy origin's path).
- A stylesheet the CSS parser cannot fully shape still reaches the page with
  its url()s routed: a block under a malformed at-rule prelude (raw text to
  the parser) is routed by the url() regex inside the parse, and a stylesheet
  the parser rejects outright is routed by the regex alone instead of being
  refused. Measured: css-tree accepted every malformed input tried, but left
  such blocks unrouted.
- A fetch or XMLHttpRequest the page aborts is dropped by the worker too.
  The browser does not relay an abort to a service worker (the request's
  signal in the fetch event never fires in Chrome, measured), so the page
  puts an id on the request and posts the abort to the worker under it; the
  worker stops waiting for the origin, reports the request at once with
  status 0 and `error: "aborted"`, and cancels the origin's answer unread
  when it arrives, so the transport stops reading. Before, the worker waited
  for the origin and reported the request as completed.
- The value of a computed member assignment is rewritten. `o[k] = v` becomes
  a `set2` call and `v` was passed to it as written, so `cache[key] = top`
  stored the real top window, `data[name] = location.href` the routed URL, and
  a function literal assigned that way kept every `top`, `location` and
  `postMessage` inside it raw. The value now goes through the rewriter like
  any other expression (rewriter-unit shape).
- A frame nested in a proxied page sees the proxied world and nothing above
  it, measured against the same pages framed natively (parent-read suite,
  both modes). `parent` was right in every form already; around it:
  `location.ancestorOrigins` lists the proxied ancestors' real origins
  (nearest first) instead of nothing; `frames[i]` and `window[i]` landing on
  a frame of another proxied origin give its restricted window, not the raw
  one (every proxied site shares the real origin); the restricted window
  reports `length` (it reported `closed`), serves its frames by index, and
  throws a `SecurityError` DOMException of the page's realm (the name was
  `Error`); and `otherWindow.top` resolves to the top of that window's world
  instead of the window itself.
- Standalone SVG documents and XHTML pages are proxied as what they are. An
  XML document got the HTML shell under its XML mime (the browser parsed the
  shell as XML and showed nothing) or, for XHTML, nothing at all (raw, with
  `top` and every URL leaking). Both now get an XML shell (the same root
  element and namespaces, XHTML script elements, CDATA) under their own mime;
  the client parses the markup with that mime, rewrites the scripts and
  re-creates the tree through the hooks, namespaces kept, under the shell's
  root (an XML document has no `document.write`; a replaced root would lose
  the SVG title). The clone helper creates every element in its own namespace
  now, so an inline SVG inserted from a markup string is an SVG element, and
  the hooks that compared uppercase HTML names (attribute routing, script and
  style insertion, the script source readback) know an XHTML document's
  lowercase ones and leave an SVG `<script>` to its own hook. A string inside
  `image-set()` or `src()` is routed like a `url()` and reads back as
  written.
- An HTML blob built from bytes (an ArrayBuffer or a typed array, as a
  `text/html` Blob or File) is decoded with the type's charset (UTF-8 by
  default) and wrapped like one built from strings; bytes that do not decode,
  and blobs built from other blobs, are left as they are.
- Relocatable asset names: `assets` on both controllers names the served
  files (`serviceWorker`, `injectDocument`, `injectWorker`, `controllerFrame`,
  `controllerFrameScript`), each defaulting to the file's own name. The
  worker's shell and the worker bootstrap build the inject URLs from them, the
  controller frame registers the worker by its name, `RemoteController` loads
  the frame by its name and tells it its script with `?script=<name>`, which
  the frame's inline loader accepts as a bare file name only (anything else
  falls back to the default). A host can therefore serve the bundle from any
  directory with every file renamed so that no requested URL carries the
  package name (assets suite: a renamed bundle boots, proxies a page and a
  worker, and the fixture saw no URL with "stomp" in it). Not URLs, so
  unchanged: the `$stomp$` postMessage keys and the `stomp` RPC id (same-origin
  messages), the `stomp-allowed-origins` meta in the controller frame, the
  `stompCookies` and `stomp-http-cache` storage names, and the default
  directory `/stomp/`.
- Request rules: `rules` on both controllers and `setRules(rules)` to replace
  them, run in the service worker on the real URL after it has rebuilt
  Referer, Origin and cookies and before the cache. A rule matches by URL
  (a URLPattern string, so `http://*:*/ads/*` includes any port), method,
  destination and site, and the first match wins: `block` answers 403 with
  an empty body, `status` answers without going upstream, `redirect` answers
  307 to a real URL (routed, nested kind kept), `requestHeaders` and
  `responseHeaders` set or delete (`null`) headers. A rule whose pattern
  cannot be compiled (URLPattern is Chrome-only today) is skipped with one
  console warning naming it. Blocked, answered and redirected requests show
  in `onRequest` with their status and the reason as `error`; every report
  of a request a rule touched carries `rule`, the rule's index. Bodies and
  functions are out of scope by design.
- A nested cross-site frame is judged by the top-level page, as a browser
  does. The page routes a child document's URL (an iframe's src, and every
  navigation from inside a nested frame: links, forms, location, history,
  meta refresh, window.open) with a route kind that names the top-level
  proxied origin, and the service worker widens the request's site by it,
  for the navigation itself and for every request whose referrer is such a
  document: a nested cross-site frame gets `SameSite=None` cookies only and
  `Sec-Fetch-Site: cross-site`, while a top-level cross-site navigation of the
  page still carries Lax. The kind is decided in the page realm, so a page
  holding the codec key could route a child as top-level; that is the same
  trust boundary as every rewriting decision.
- The HTTP cache serves stale entries exactly as far as the origin allowed:
  within `stale-while-revalidate` a stale entry answers at once and one
  revalidation per URL runs behind the page (however many stale hits arrive
  together); within `stale-if-error` a stale entry answers for a 5xx or a
  request the transport could not complete. Past either window, and under
  `must-revalidate`, nothing changes. A cache-served response carries an
  `Age` header (the standard marker; `Warning` is deprecated) and the request
  log says `cached: true`. Still no heuristic freshness: an entry without
  explicit freshness is never stored.
- A document the page builds itself and shows from a `blob:` URL (a
  `text/html` Blob or File in a frame or a window) is injected and rewritten
  like a fetched one: its string contents are wrapped in the shell at
  construction, with the page as its URL (`location`, relative URLs, the
  spoof all answer for the page). Blobs of any other type, untyped blobs and
  HTML blobs built from binary parts are untouched.
- The Referer follows the page's own referrer policy. The browser derives
  every request's policy natively (the document's `Referrer-Policy` header,
  which now reaches the browser; `<meta name="referrer">`; an element's
  `referrerpolicy`; fetch's `referrerPolicy` init), and the service worker
  applies all eight policies to the real origins. In proxy URL space every
  proxied request looks same-origin to the browser, so its own Referer is
  used only to learn the initiator; when a policy made it send the proxy
  origin alone, the initiator is the request's client document. An empty
  policy is `strict-origin-when-cross-origin`, as before.
- `document.cookie` no longer costs a synchronous round trip per read: the
  page caches the string and drops it when the jar may have changed, on its
  own write, on a write by another document of the site (a version the
  writer bumps in the proxy origin's own storage, seen synchronously), when
  a response reaches the page (fetch, XHR), and on the service worker's
  broadcast for a Set-Cookie it applied, sent before it answers the response
  that carried it, so the next read is fresh. Fifty reads cost one round
  trip.
- A child frame whose parent touched it before it loaded (its initial
  about:blank window is reused for the real document) threw "Illegal
  invocation" on every `document.cookie` access: the parent's client had
  hooked it and checked against the parent's document.
- Leak fix: the sync route behind `document.cookie` (`/cookies/get`) handed
  page script the whole jar, HttpOnly cookies included, and relied on the
  page's own module to filter them out. The route now answers without them.
- WebSocket handshakes carry the jar's cookies, HttpOnly ones included, under
  the SameSite rules for the page's origin (its Origin header; `ws` counts as
  `http` for the site). The controller adds the Cookie header to the
  handshake in its own realm (the page's module no longer sends one, and one
  the page sends is dropped), so the value never enters the page; without an
  answer from the worker the handshake goes out without cookies. A
  WebSocket URL may be relative or `http(s)`, as in a browser. The Cookie
  Store API is removed from pages, so feature detection falls back to
  `document.cookie`, which the jar serves.
- Styles and references read back as the page wrote them: computed styles
  (`getComputedStyle`, property and `getPropertyValue`), an inline style's
  `getPropertyValue`, and the Typed OM's values stringify with the page's
  `url()`; what the page parses (`CSSStyleValue.parse`) or sets on a
  `StylePropertyMap` is routed; an SVG reference's `href.baseVal` and
  `animVal` are the written value and setting `baseVal` routes;
  `document.domain` accepts the page's host or a parent domain and refuses
  anything else with a `SecurityError`, as a browser does, instead of the
  proxy origin's refusal.
- A script that arrives in a markup string (`innerHTML`,
  `insertAdjacentHTML`, `outerHTML`) no longer runs: the browser's fragment
  parser marks such scripts "already started" and Stomp's re-creation of the
  parsed nodes had lost that, so the script ran, and raw. The parsed script
  element is adopted instead of re-created.
- Markup is read the way the browser reads it: a script runs rewritten
  whatever the case, spacing or legacy spelling of its JavaScript MIME type
  (and the `language` attribute), with `module` matched as Chrome does; a
  link's `rel` is a token list and a preload's `as` decides its route
  (`stylesheet` or `as=style` to the CSS route, `modulepreload` and
  `as=script` to the script route, the rest binary); SVG gradients,
  patterns, filters, animations, cursors and `tref` route their `href` or
  `xlink:href`, an SVG `<script>` as a script, and an SVG `<a>` made with
  `createElementNS` like an HTML link.
- The Cookie header follows SameSite: the service worker asks the jar with
  the request's site (from the fetch metadata it computes), whether it is a
  navigation and its method, so a cross-site subresource carries
  `SameSite=None` cookies only and a cross-site GET navigation adds Lax but
  never Strict. Every proxied page reaches the worker as an iframe
  destination, so iframe navigations count as top-level: a cross-site link
  into a site that keeps its login in Lax cookies works, and a nested
  cross-site iframe gets Lax cookies a browser would withhold.
  `controller.cookies.list()` records carry `hostOnly`. (Nested frames are
  judged by the top-level page since the nested route kind.)
- The HTTP cache serves a request that arrives while the same URL's entry is
  still being written (its body streaming into the store) from that entry,
  instead of racing it upstream; on a slow machine the second of two fetches
  in a row could miss. A controller handed a worker other than the
  registration's active one now moves to the active one at once, before
  waiting on an update.
- Documents that escaped the rewrite: a child frame's `sandbox`, `csp` and
  `credentialless` attributes are dropped (an opaque origin or a policy would
  put its document outside the service worker; the page reads them back as
  written), an import map's targets are routed as modules (package prefixes
  and scope keys are left as written: they are URL prefixes a routed URL
  cannot keep), and an about:blank popup the page opens without a URL is
  injected like a child frame, so what the page writes into it is rewritten.
  `window.open` hands only http(s) URLs to the host's `onOpen`.
- A proxied page reads its own URLs back: `PerformanceEntry.name` and
  `toJSON` un-route (`getEntries*`, `PerformanceObserver` lists and
  `takeRecords` hide the inject bundles' entries; `getEntriesByName` takes
  the page's URL), `hashchange` `oldURL` / `newURL` and the Navigation API's
  entry and `destination` URLs are the page's, error stacks name the page's
  scripts (V8 `Error.prepareStackTrace`; a page's own formatter runs on
  cleaned frames, inject frames dropped), a script the page inserted reads
  back the source it wrote, and `document.documentURI` / `window.origin`
  agree with `document.URL` / `location`. Parser-inserted scripts no longer
  read `&amp;` for `&` in `currentScript.textContent`.
- `RemoteController` is an `EventTarget` like `StompController` and mirrors
  the controller frame's `stale` property and its `stale` / `rebind` events
  (one RPC from the frame), so an isolated host shows the same notice.
- A URL attribute changed after it was routed takes effect. Once the hooks had
  routed an element's `href` or `src`, every later `setAttribute` or property
  assignment was discarded in favour of the stored original, so links and
  images never updated after their first routing; the hooks now tell their
  own value from one the page changed.
- Links and the URL attributes around them: `<area href>` is routed like
  `<a href>`; `formaction`, `input[src]`, `video[poster]`, `track[src]`,
  `object[data]`, `frame[src]` and `link[imagesrcset]` are routed and read
  back as written; the URL parts of a link (`a.pathname`, `a.host`,
  `String(a)`, also on `<area>`) are the link's own instead of the page's,
  and setting one updates the link, routed.
- The cookie jar follows RFC 6265bis: cookies set without `Domain` are
  host-only, `Domain` matches by label and never a public suffix, paths match
  on a boundary from the request's default path, `Secure` cookies go to secure
  URLs only and an insecure origin cannot replace them, `__Host-` /
  `__Secure-` prefixes, the 4096-byte cap and control characters are enforced,
  `SameSite=None` needs `Secure`, `Max-Age` beats `Expires` with a 400-day
  cap, the Cookie header lists longer paths first then earlier creations, and
  a page's script can neither set nor replace an HttpOnly cookie. Session
  cookies survive a service worker restart (they were wiped every time the
  idle worker was restarted, which logged users out).
- A build mismatch at the handshake never blocks the page. After a deploy the
  page loads the new controller bundle while the old service worker is still
  the active one, so the controller updates the registration and, when the
  new worker activates within five seconds, binds to it
  (`controller.rebind(worker?)`, public) and shakes hands again. When it does
  not (the old worker is pinned by a request that never settles), `wait()`
  resolves on the old worker, `controller.stale` records both builds with a
  `stale` event for the host's notice, and the new worker is adopted the
  moment it activates (`updatefound`, `controllerchange`; a `rebind` event
  follows). `wait()` no longer rejects over a version mismatch.
- The service worker bounds every routed request: a response that has not
  started after 60 seconds (120 for documents and media) is answered 504
  with a short error page or an empty body, so a transport request that
  never settles cannot keep the worker alive and block a waiting worker of a
  newer build from activating.
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

- `Error.prepareStackTrace` reads back as a function (Stomp's formatter)
  instead of `undefined`; scripts created from markup strings read back
  rewritten.
- Aborting a fetch does not cancel the request on the transport (epoxy
  ignores the signal); the response is discarded.
- The HTTP cache uses no heuristic freshness (`Last-Modified` alone stores
  nothing); stale entries are served only within the origin's
  `stale-while-revalidate` and `stale-if-error` windows.
- `getSVGDocument()` is not spoofed.
- `CSSRule.cssText` assignment is not rewritten (a no-op for style rules).
  Un-rewritten `url()` values read back as the page wrote them (relative
  when written relative), not as the absolute URL a browser would serialise.
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
  rewritten; worklet modules get no inject; an HTML blob built from another
  Blob is shown as it is.
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
- Without `onOpen`, `_blank` and named targets open the proxied page in a
  bare new tab outside the host application (the frame sandbox keeps
  `allow-popups`).
