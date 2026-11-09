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

- `names.error`: the global the worker writes into the host's error page
  (`globalThis.stompError = { url, status, error, kind }`) is the fifth
  configurable helper name, default `stompError`, validated like the others.
  A host whose build renames identifiers in its vendored pages (the example
  error pages read `globalThis.stompError`) sets it to the name its page ends
  up reading, so the worker's template and the page agree (error-page suite).
- `NavigateInfo.icon`: the page's icon as the page declared it (the first
  `<link rel="icon">` or `shortcut icon`, else the first `apple-touch-icon`,
  resolved against the real URL; null without one), in every navigate report
  and reported again when the page swaps it, so a host never reads the
  frame's DOM for a favicon. `controller.unroute(url)` on both controllers:
  the real URL a routed one stands for, the inverse of `route()` with the
  controller's codec, null for anything that is not a route (navigate-events
  suite).
- `controller.build` on both controllers and `BUILD` exported from the
  controller module: the build identifier baked into the bundle (version plus
  commit, or the package version), which only the `stale` event exposed. The
  worker's build stays `config.build`; `stale` says when they differ (version
  suite).
- `hooks` on `StompController` and `RemoteController`: host code run inside
  every proxied realm, scramjet's `Frame.hooks.init.pre` and `post` by name,
  as scripts that travel rather than closures (a realm on the proxy origin
  cannot reach the host's objects). `hooks.init.pre` runs before the inject
  installs its hooks and `hooks.init.post` after, before the page's first
  script (after the document re-open a written page goes through, so
  listeners survive); in the page, its nested frames, about:blank children,
  popups and srcdoc frames, and with `hooks.workers` in dedicated and shared
  workers. Each phase is `{ source }` (the text) or `{ url }` (fetched once at
  construction; its text is what travels, so a redeploy of the file needs a
  new controller). The code runs raw with the realm's real globals and one
  argument: `{ url, origin, isTop, nested, kind, phase, names, frameId,
window }`, `frameId` being the controller's id. It is trusted host code,
  and what it leaves on the window is reachable by the page. A throw never
  reaches the page: it is logged in the realm and reported to the host as a
  `hookerror` event, `onHookError` and `controller.hookErrors`; a URL that
  cannot be fetched is reported the same way and the controller serves
  without it. A bad shape is a `TypeError`. Types `InitHooks`, `HookScript`,
  `HookContext` and `HookErrorInfo` are exported (realm-hooks suite, both
  modes).
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
  request that reaches this worker under an address finds the file; a page
  served by a worker of the previous build stays blank until the version
  self-heal swaps the worker. A replaced controller's calls reject with
  "Controller replaced", and a request on a transport port whose other side
  is gone fails at once instead of waiting out the worker's timeout. A tab
  that crashes or is discarded fires neither `pagehide` nor a port close, so
  its entry lingers until the worker restarts: documents at its address get
  the orphan answer, its stale subresource links wait out the bounded
  timeout. The
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
- test: a bounded set of web-platform-tests is vendored under `test/wpt/`
  (456 files, 3.4 MB, upstream `cbd1ca1e`: cookies, fetch/metadata and the
  referrer-policy top-level and attribute matrix, with testharness.js and a
  report script of ours) and run as the `wpt-cookies`, `wpt-fetch-metadata`
  and `wpt-referrer-policy` measurement suites: every page runs natively from
  the fixture and again in a proxied frame, and the verdicts are compared per
  subtest against `test/wpt/expected/<suite>.json` (a new proxied failure
  fails the suite, so does a listed failure that now passes;
  `UPDATE_EXPECTED=1` rewrites the list). `test/wpt-server.mjs` ports what the
  tests need from wptserve: `.sub.` substitutions over the fixture's two host
  names, `.headers` sidecars, `.any.html` wrappers and the python handlers.
  First measurement (subtests passing natively, then proxied): cookies 764
  to 306 of 942, fetch-metadata 517 to 255 of 855, referrer-policy 2418 to
  1315 of 2522; the causes are in the parity doc's WPT row. Nothing is fixed
  here.
- `examples/minimal-host.html` is the smallest host application (same-origin
  `StompController` on epoxy, one frame, the three callbacks), served by the
  demo at `/examples/`; README "Embedding" walks through it, and the new
  `host-api` suite runs the host API checklist against it.
- The demo has a request viewer: long-press Recents or Ctrl+Shift+X slides
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

- A request in the moment after the service worker restarts waits for its
  controller. A restarted worker knows no controller until they answer its
  revive, which takes a few hundred milliseconds (over a second when the
  controller checks first), and a routed request in that window was not
  answered at all, so it went to the host's own server: a fetch got a 404
  and a reload showed the host's error page. For three seconds after the
  worker starts, a request under an address whose controller has not
  registered is held until that controller does (another controller
  registering first does not take it over), then answered as before
  (sw-restart suite, both modes; multi-controller, two controllers, one of
  them late).
- A contextual fragment's loads go through the proxy.
  `Range.createContextualFragment` makes its nodes in the page's document,
  so an image in it loads as it is parsed, inserted or not, and the hooks
  never saw it: a cross-site URL was fetched straight from the site, past
  the proxy, and a relative one from the proxy origin unrouted. The markup
  is now parsed by the browser in an inert document, in a context element
  of the range's kind, and the nodes are made in the page's document
  through the hooks; a script in it runs when the page inserts it
  (contextual-fragment suite, both modes, against the page loaded
  natively).
- A controller shakes hands again after a service worker restart that comes
  soon after its last handshake. A restarted worker knows no controller and
  asks them once to register again; the controller ignored that request for
  two seconds after a handshake, taking it for the startup broadcast of the
  worker its own handshake had started. A worker that stopped within those
  two seconds (Chrome stops idle ones; a crash) took the registration with
  it, and its successor's only request was ignored: every routed request of
  the page fell through to the host, a 404, until a later restart. Within
  the two seconds the controller now asks the worker over its port and
  shakes hands again when it gets no answer within a second (sw-restart
  suite, both modes, the worker stopped over CDP).
- A blob: worker the service worker knows nothing about is judged as
  another site's, never as its target's own. What pages tell the worker
  about the blob: URLs they mint lives in its memory, which Chrome empties
  when it stops an idle worker (after about 30 s): a long-lived blob
  worker's next request then came from an unknown blob: client, and went out
  as `Sec-Fetch-Site: same-origin` with the target's cookies, SameSite=Strict
  ones included. It now goes out cross-site, with no cookies under
  `same-origin` credentials and none but SameSite=None ones under
  `include`. A blob worker's requests to its own page's origin lose their
  cookies after such a restart, which is the safe side of not knowing
  (blob-worker-site suite, both modes: the service worker stopped over
  CDP, then the live worker's requests compared with a cross-site request
  natively).
- A URL property reads back right when no hook took its attribute. The
  getters resolved the page's original value from the hooks' marker, and a
  value no hook took (a link's `href` before it has a `rel`) has none, so
  `link.href` read `<page directory>/null`. They now fall back to the
  attribute as written (property-order suite, both modes, against the page
  loaded natively).
- A blob: worker's requests are judged as the page that made it. The
  worker's client URL is the blob: URL, which the service worker could not
  decode to a page, so it took the request as its target's own: an
  importScripts or fetch to another site went out as `Sec-Fetch-Site:
same-origin`, and with the default credentials carried that site's
  cookies, SameSite=Strict ones included. A page now tells the service
  worker which blob: URLs it mints; the worker records each under the real
  origin of the document that told it, read from that document's own routed
  URL, never from the message, and judges the blob's worker by it: another
  site is cross-site and gets no cookie under `same-origin` credentials.
  Entries outlive `revokeObjectURL` (pages revoke right after
  `new Worker()`) and go with the document that minted them. A blob: URL
  minted inside a worker is not registered (a worker cannot reach the
  service worker) and is judged as another site's, below (blob-worker-site suite, both
  modes, against the page loaded natively; WPT fetch-metadata
  worker-dedicated-importscripts passes, its seven entries are off the
  expected list).
- A proxied page may use what its frame's sandbox does not exist to stop.
  The sandbox only keeps a page from navigating the host, but it lacked
  `allow-presentation` and `allow-orientation-lock`, so `new
PresentationRequest()` (Spotify) and `screen.orientation.lock()` threw
  SecurityError, and popups a page opened inherited the sandbox, which they
  never have natively. `DEFAULT_SANDBOX` now adds those two flags and
  `allow-popups-to-escape-sandbox` (frame-features suite, both modes,
  against the page loaded natively).
- A `<style>` in a declarative shadow root, a plain template or a
  `<noscript>` stays a style through the page load. While the written page
  is prepared, each parsed `<style>` is replaced by a script that puts it
  back with `document.currentScript.outerHTML`. In a shadow root
  `currentScript` is null, so the script threw "Cannot set properties of null
  (setting 'outerHTML')" and the root lost its styles (every Lit component on
  MDN); in a template the page found a script in `content`, and in a
  noscript the script markup became its text. cloneRawNode marks what it
  makes below a template or a noscript, and those styles keep their
  (already rewritten) text in place (html suite).
- A no-break space in a page's script, style or JSON payload reads as the
  character again, not as the text `&nbsp;`. The HTML shell escapes the
  page's markup with `entities`' `escapeText`, which writes U+00A0 as
  `&nbsp;`, and `loadHTML` decoded it at the XML level, which only knows
  `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&apos;`. Text outside raw text
  elements was parsed back by the browser, so only scripts, styles and
  noscript contents kept the entity: BBC News's `__NEXT_DATA__` handed React
  "sites.&nbsp;" where the server had rendered a no-break space, and
  hydration failed with React errors #425, #418 and #423. `loadHTML` decodes
  at the HTML level, the inverse of `escapeText` (html suite).
- discord.com no longer throws "Maximum call stack size exceeded" for every
  script OneTrust's OtAutoBlock creates. OtAutoBlock gives each one an own
  `setAttribute` and own `src` and `type` accessors that write through the
  hooked `setAttribute`. The hooks swap an element's prototype while they
  work, but an own property shadows any prototype, so the `setAttribute`
  hook called the page's own, which called the hook again. The element's own
  configurable properties that the hook prototype also has are now set aside
  while the hooks run (instance-overrides suite, both modes, against the
  page loaded natively).
- twitch.tv no longer overflows the stack while it renders, and it renders
  as many elements as natively (about 1700, was about 1500). Every
  `localStorage` and `sessionStorage` call was a synchronous beacon to the
  service worker, and Chrome refuses a document's beacons once 64 KiB of
  them are in flight. Twitch reads one flag key over a hundred times in one
  task, so the reads after that threw `QuotaExceededError`, which a native
  read never does, and its error logger, which reads a flag again, recursed.
  A document now keeps what it read and wrote while a stamp in the proxy
  origin's own localStorage is unchanged, and every write by any document
  changes the stamp, so another document's write is still read at once.
  Storage events the browser fires about the proxy origin's own storage (the
  stamps, the cookie cache's, a same-origin host's) no longer reach the
  page (storage-burst and storage-events suites, both modes).
- `new Request(url)` with a URL that does not parse against the page's (a
  relative one in a data: worker, whose origin is opaque) throws the
  TypeError Request throws natively (`Failed to parse URL from ...`), not the
  URL constructor's `Invalid URL` from inside the inject (helper-realms
  suite).
- A javascript: URL in a fresh iframe runs. `iframe.src = 'javascript:...'`
  (or the attribute, or the markup) runs its body in the frame's initial
  about:blank, which nothing injected unless the page had read the frame's
  `contentWindow`, so the rewritten body threw `$s$j is not defined` and
  never ran (adv-scripts, both modes). The rewritten URL now has the
  parent's client inject the frame first, the way reading `contentWindow`
  does; a page, or a frame already injected, has its own client and nothing
  happens (helper-realms suite).
- A blob: module worker runs. Its bootstrap was built with the page's
  `Blob`, which a document hooks to rewrite script blobs, so our own
  preamble was rewritten once more and called the access helper before it
  had loaded the inject (`$s$j is not defined`); and its static import ran
  the page's module before the preamble, so a top-level read of
  `self.location` threw the same way. The bootstrap is made with the native
  `Blob` and imports the page's module once the client is in place. Module
  workers also lost the messages posted to them at once: the browser
  dispatches them during the preamble's top-level await, before the page's
  module has set its handlers, where natively its top level runs first. The
  preamble holds them (and a shared worker's connects) and the client
  dispatches them again (helper-realms suite, against the page loaded
  natively).
- A same-origin frame's hooked functions read as native from its parent.
  Each proxied frame loads its own copy of the inject, whose wrappers the
  parent's copy never made, so the parent's `Function.prototype.toString`
  showed a frame's `fetch`, `open`, `document.write` and `toString` as the
  wrapper's source. A function of another realm is now handed to that realm's
  own toString, whose copy knows its wrappers (function-strings suite, both
  modes, against the page loaded natively).
- A defined custom element in a template's markup is no longer
  constructed until the page stamps it. The hooks that take a markup string
  (a template's `innerHTML`, markup holding a `<template>` through
  `innerHTML`, `insertAdjacentHTML`, `outerHTML` or a written document) made
  a template's children in the page's document, so each one was constructed
  with its attributes still the page's "[[...]]" bindings, which Polymer and
  YouTube take off before they clone the template. YouTube's watch-next
  renderer read `shownItems` as the string `"[[watchNextShownItems]]"` and
  threw `E.some is not a function` on every load. A template's children are
  now made in its own inert content document, as the browser parses them.
  The copies `setHTMLUnsafe`, a shadow root's `innerHTML` and
  `document.write` build to rewrite their markup are made in an inert
  document too: made in the page's, every custom element in them was
  constructed twice (custom-elements suite, both modes, against the page
  loaded natively).
- A URL property set before the attribute that makes it a load holds the
  page's URL as written. `link.href` set before `link.rel` (YouTube's player
  loads `www-player.css` that way) was read back through the browser's
  getter and written into the attribute, resolved against the document's
  real URL, the proxy's; when the rel came, the stylesheet was fetched from
  the proxy origin and refused. The player never built: through the proxy
  YouTube's home page rendered about 1,600 elements where it renders about
  2,000 natively, `ytd-player` holding 2 of its 406. The setter now leaves
  the attribute as the page wrote it when no hook took the value, and the
  home page renders the same elements, tag for tag, as natively
  (property-order suite, both modes, against the page loaded natively).
- `fetch(request)` fetches the request's own URL, not a `url` the page
  defined on the object. YouTube checks its fetch with a `data:` Request
  whose `url` and `method` it shadows with getters naming its player
  endpoint, and expects the data back; the hook read the shadowed `url`, so
  every load sent a GET to `/youtubei/v1/player` (405) and told YouTube its
  fetch was patched. The hook reads the URL through the native getter, and
  a Request it does not route is fetched as itself (page-apis suite).
- A fetch, image, script or other load from an iframe's initial about:blank
  document sends no Referer, as natively (about:blank strips to no
  referrer); a fetch that names a referrer still sends it under the policy
  about:blank inherited. No service worker controls that document, so its
  loads go through the parent's realm, and they carried the parent's
  referrer (blank-referrer suite, both modes, against the page loaded
  natively; WPT referrer-policy iframe-inheritance-about-blank passes, its
  two entries are off the expected list).
- `document.referrer` in an iframe's initial about:blank document is its
  creator's full URL, whatever the referrer policy, as natively: it read
  empty, because the readback compared the routed referrer's origin with the
  document's location origin, which about:blank and srcdoc documents read as
  `"null"` (blank-referrer suite, both modes, against the page loaded
  natively; WPT referrer-policy iframe-inheritance-about-blank).
- A subresource whose connection fails (nothing listens, the host does not
  resolve, the connection drops before an answer) is a network error for the
  page: fetch rejects with a TypeError, an XHR fires `error` with status 0
  and a synchronous XHR throws, as on the real site. The worker answered it
  with a 500 JSON body of its own, so the page's fetch resolved. A response
  the transport received and refused to parse (hyper's header parser
  rejects a control character in a header value, which Chrome reads) still
  gets an error response (network-errors suite, both modes, against the page
  loaded natively).
- Scripts are rewritten off the service worker's thread. The service worker
  rewrote every script itself, one at a time, so a page of large scripts
  waited for each in turn (six 600 KB scripts took about a second to arrive,
  natively about 115 ms). The controller now starts rewrite workers
  (`rewriteWorker.js`; `rewriteWorkers`, default half the cores, one to
  four, `0` for none) and hands the service worker a port to each with the
  handshake; a script goes to the worker with the fewest in hand, and comes
  back byte for byte what the service worker would have made. The first load
  of that page went from about 1030 ms to about 530 ms. A worker is used
  once it says it is ready, so one that failed to load costs nothing; the
  service worker rewrites the script itself whenever no worker is ready or
  one has not answered within `rewriteTimeout` (default 10 s; that worker is
  not used again), and lets the workers go with their controller. The
  request log says where (`rewriteIn`: `pool` or `service-worker`). The
  inline scripts of an HTML document are still rewritten in the service
  worker, with the document (rewrite-pool suite).
- A script's rewritten output is kept in a cache of its own (Cache API,
  `stomp-rewrite-cache`), keyed by a digest of the body with everything the
  output depends on: the URL, the script type, the config, the codec key and
  the build. A script loaded again with the same body is answered without
  rewriting it, byte for byte the same; a six-script page of 600 KB scripts
  went from about 1000 ms to about 155 ms on the second load (natively about
  105 ms), and Chrome's extra fetches of a parser-inserted script are hits.
  It keeps only what the HTTP cache's privacy rules allow (no `no-store` or
  `private`, no Authorization, no cookie without `public`), at most 300
  entries of 8 MB (the oldest go first), and is cleared with the
  HTTP cache (`clearCache()`, a new codec key) and whenever a new service
  worker activates. `cache: false` turns it off with the HTTP cache. The
  request log says which it was (`rewriteCache`: `hit`, `miss` or `skip`)
  (rewrite-cache suite). A `no-cache` script is kept too: its body arrives
  every time and is the key, so nothing goes stale.
- A minified script is rewritten minified. The generator indented and broke
  every line, so a minified library came back up to twice its size (three.js
  614 KB to 986 KB, TinyMCE 457 KB to 876 KB): the worker spent the time
  writing it and the page reading and parsing it. Minified input (lines over
  200 characters on average) now comes back about its own size (three.js
  666 KB), its stack positions on one line as natively; code written to be
  read keeps one statement per line, so an error's line number stays near
  the page's own (rewriter-unit suite).
- Synchronous requests carry binary and non-UTF-8 bodies byte for byte. The
  synchronous bridge decoded every response body as UTF-8 in the service
  worker, and its cookie encoding could not carry a character past U+00FF,
  so a sync XHR for a font or an image (or any non-UTF-8 text), and a
  script copied through the bridge into an uncontrolled document with CJK
  text in it, arrived corrupted; storage values past U+00FF read through the
  bridge did too. A UTF-8 body now travels as its text and anything else in
  base64, and an ArrayBuffer or typed array request body as its bytes (it
  was decoded as UTF-8, and a Uint8Array was dropped). XMLHttpRequest
  decodes text as the browser does, in documents and workers, sync and
  async: the `overrideMimeType()` charset first (it did nothing, so the
  classic `charset=x-user-defined` binary read failed), then the response's
  Content-Type charset, a byte order mark over both, UTF-8 otherwise. A
  worker's synchronous XHR works (it threw; Chrome hands it to the service
  worker, so the browser's own XHR carries it), with any responseType, and
  a worker XHR with the default type has its responseText. A document's
  refusal of a responseType on a sync request is an `InvalidAccessError`
  as natively (sync-binary suite, both modes, against the page loaded
  natively).
- Typed OM writes in a document no service worker controls load through
  the proxy: an `attributeStyleMap` set, append, delete or clear now has
  its element's inline style copied as a CSSOM write is, underneath the
  hooks, so the page's MutationObserver sees only its own write. A Typed
  OM value read back (`attributeStyleMap.get(...)`, a parsed
  CSSStyleValue) showed the page's url() with its quotes escaped
  (`url(\"...\")`); it reads as the page wrote it (blank-sources suite,
  both modes, against the page loaded natively).
- Constructed stylesheets in a document no service worker controls load
  through the proxy: the url()s and fonts of a sheet the page makes with
  `new CSSStyleSheet()` and fills with replaceSync, replace or insertRule,
  adopted by the document or a shadow root, reached the proxy origin's own
  server. Once its rules change (replace: once they are in) the sheet's
  routes are copied and put back as a `<style>`'s are, a style rule
  through its own declarations, so a rule the page holds stays the sheet's
  own and the CSSOM reads back what the page wrote; the copies are the
  sheet's and are released when its rules no longer show them. An @import
  in a constructed sheet is still dropped, as natively. Copying into a
  `<style>`'s style rules failed with "Illegal invocation" (the native
  methods were handed the readback's view of the declarations), which left
  those rules with their routes; they now take their copies (blank-sources
  and blank-loads suites, both modes, against the page loaded natively,
  with the bypass recorder).
- A FontFace a page makes in a document no service worker controls loads
  its source through the proxy. `new FontFace(name, 'url(...)')` there
  fetched the font from the proxy origin's own server, so `load()` and
  `document.fonts.load` failed with a NetworkError. A face's source cannot
  change once it is made and the face fetches from the realm that made it,
  so a copy made later could never reach it: a face whose source names
  routes is made instead with the FontFace of the nearest controlled realm
  (the one routed fetches go through), keeping the document's own
  prototype, and its `loaded` and `load()` promises are the document's own.
  A face from an ArrayBuffer, and any face in a controlled document, is
  made as before (blank-sources suite, both modes, against the page loaded
  natively, with the bypass recorder).
- SVG references in a document no service worker controls load through the
  proxy: an `<image>` by href or xlink:href, a `<use>` of an external
  sprite (its fragment kept on the copy), an `<feImage>` and an SVG
  `<script href>` reached the proxy origin's own server and failed. They
  are copied like an `<img>`, and released when the element shows another
  value; an SVG script the page writes is copied at once, as an HTML one
  is. An xlink:href a hook holds back while its copy loads is set again in
  the xlink namespace, so the element still sees it, and the page's
  MutationObserver sees no record of it. getAttributeNS for a namespaced
  attribute a hook rewrote, getAttributeNames and the markup now read back
  as the page wrote them, in the order it wrote them, also for an
  attribute set again once its copy arrived (blank-sources suite, both
  modes, against the page loaded natively, with the bypass recorder).
- `document.write` and `writeln` are the prototype's methods again. The
  hook was an own property of each document, which a page could list
  (`Object.getOwnPropertyNames(document)`) and compare
  (`document.write !== Document.prototype.write`); it is now on
  Document.prototype, where the browser has it, so a popup's or a frame's
  document finds its own realm's hook and client. A hooked function of
  another realm the inject made (a popup's `write`, a frame's `fetch`) read
  through the page's own Function.prototype.toString gave the wrapper's
  source: the native source is now known to every realm of the bundle
  (written-documents suite, both modes, against the page loaded natively).
- getHTML with shadow roots the page lists serializes them as the browser
  does: an open root that is not serializable and a closed one, passed in
  `shadowRoots`, come out with the browser's own template attributes. The
  copies keep each root's flags and the browser's serializer gets the page's
  options with the copies of the listed roots, so it decides what to include
  as it would on the page's own (markup-parity suite, both modes).
- getHTML reads a page's markup back as the page wrote it. It returned the
  proxy's routed URLs and its `s_o:` markers (innerHTML and outerHTML did
  not); an element's and a shadow root's getHTML now serialize a folded
  copy in the inert document, a copy of every shadow root they would
  include (open and serializable, or listed in `shadowRoots`) attached to
  the copy of its host, and go through the CSS and script readbacks as
  innerHTML does (markup-parity suite, both modes, against the pages loaded
  natively).
- A whole document a page writes keeps its doctype and its html, head and
  body tags. Written markup was rewritten as a fragment, which dropped the
  doctype (the document rendered in quirks mode) and the attributes of the
  html, head and body tags: an editor frame lost its body's
  `contenteditable` and class. A write that opens a fresh document (just
  opened, or written once it had loaded) and starts with them keeps them,
  their attributes through the hooks as any element's; the head's content
  and the rest are rewritten as before, and a write into a document already
  being parsed stays a fragment (written-documents suite, both modes,
  against the page loaded natively).
- What a page writes into a document no service worker controls loads:
  an editor's frame (`<iframe src="">` written once it loads, as CKEditor 4
  does) and a popup its opener writes into now show the written stylesheet
  and images. The copy of each load was made on the clone the written
  markup is rewritten on, and the element the parser made had only its
  marker; now the parser's elements get their copies once the write is in
  (scripts keep the copy they got during the write). A write into a
  document that had loaded opens it again, as the browser does, and counts
  as opened (written-documents suite, both modes, against the page loaded
  natively, with the bypass recorder).
- Reading a page's markup back loads nothing. innerHTML, outerHTML, a
  shadow root's innerHTML and XMLSerializer give the page its own markup by
  copying the subtree and folding the hooks' markers back; the copy was made
  in the page's own document, where every image and media source the fold
  put back (the page's raw URLs) started loading straight from the site.
  The copy is now made in a document with no window (one for HTML, one for
  XML), where nothing loads or runs, and serializes as before
  (property-sets and blank-loads suites, both modes, with the bypass
  recorder).
- A URL property a page sets never loads past the proxy. A reflecting
  property's setter handed the page's raw value to the browser's own setter
  before the hooks routed it, so a script, stylesheet, frame, embed or
  object already in the document given its URL by property (`s.src = ...`
  after appending, `iframe.src = ...` on a frame on screen) loaded it
  straight from the site, and in a document no service worker controls an
  image or a media element did too. The value now goes into the hooks'
  view of the attribute, as with setAttribute, and only the route or copy
  they make reaches the element; `style`, which forwards to cssText, keeps
  its own path (property-sets suite, both modes, with the bypass recorder).
- A `<style>` rule the page holds stays the sheet's own while its loads are
  copied in a document no service worker controls: a style rule takes the
  copies into its own declarations, as an inline style does, instead of
  being deleted and inserted again (which detached the page's reference).
  Only @import and @font-face rules, which have no declarations to edit,
  are still put back whole (blank-loads suite, both modes).
- A frame whose sandbox the page builds through its token list loads through
  the proxy. `iframe.sandbox.add`, `.toggle`, `.replace`, `.remove` and
  `.value =` write the attribute without any attribute hook seeing it, so the
  sandbox Stomp drops stayed on the real frame. reCAPTCHA sets its anchor
  frame's sandbox, then adds each newer flag the browser supports that way:
  the frame was sandboxed with those flags alone, an opaque origin whose
  navigation skipped the service worker, and the proxy server answered its
  `html:nested` route with a 404 (seen on the TinyMCE docs through
  stomp.fracit.al). A hooked list's call now runs on a detached copy holding
  the page's value and writes the result through the page's `setAttribute`,
  so it returns, throws and shows MutationObserver records as natively and
  the page reads its full sandbox back (sandbox-tokens suite). The list's own
  reads (`value`, `contains`, iteration) still show the real, empty list.
- CSS a page writes into a document no service worker controls loads its
  images through the proxy: a `<style>`'s rules, a style attribute and a
  CSSOM write (`el.style.x = ...`, setProperty, cssText) have their url()s
  copied, and the copies are set underneath the hooks (a rule is put back
  through the CSSOM, an inline style with the declaration's own setProperty
  inside the hooks' write scope), so the page reads back its own text and
  its MutationObserver sees only its own writes. The copies are the
  element's: an inline style or a `<style>` that changes keeps the copies it
  still shows and releases the rest. Typed OM writes, constructed sheets
  and FontFace sources in such a document are not covered (blank-loads
  suite, both modes, against the page loaded natively).
- A stylesheet a document no service worker controls loads has its own
  loads copied too: its url()s, its @import (whose own url()s are copied in
  turn, four levels at most) and its fonts reach the proxy instead of the
  proxy origin's own server, and the copy reads back as the same stylesheet
  does in a controlled document (the page's token kept after each copy's
  marker). The copies go with the stylesheet's (blank-loads suite, both
  modes).
- A script the page writes (document.write) into a document no service
  worker controls runs in place, in the order it does on the real site: its
  copy is made at once through the synchronous bridge from the nearest
  controlled document, so it blocks the parser as natively, and one that
  writes the next script (an ad chain) runs that one before what follows.
  This holds with the transport in the transport worker (a
  TransportDescriptor, the default), where the bridge completes; the
  controller says so in the config (`workerTransport`). With the transport
  in the page (an instance, or `host: 'page'`) the bridge would spin to its
  limit, so there a written script still does not run: the known limit. The
  bridge is given 5 s at most, and a failure falls back to the asynchronous
  copy (blank-loads suite, both modes and both transport hosts, against the
  page loaded natively).
- In a document no service worker controls, async=false scripts run in the
  order the page added them. Each gets its source once its copy is in, and
  the browser runs such scripts in the order they get one, so a slow script
  ran after a fast one added after it. A copy is now applied only once every
  earlier async=false script of the document has had its own (blank-loads
  suite, both modes and both transport hosts, against the page loaded
  natively).
- A srcset copy that fails no longer leaves its other copies alive: every
  candidate's copy is waited for, and when one fails the others are released
  with it. The copies are made and released with the URL functions the page
  had when the proxy started, so a page that replaces them sees none of
  the proxy's.
- A copy loaded for a document no service worker controls is released once
  its element shows another value: an editor frame that swaps its images no
  longer keeps every earlier blob alive. The old copies are revoked after the
  new value is set (a media element plays the old one until then), and a
  copy that arrives after its value was replaced is released at once
  (blank-loads suite, both modes).
- Documents a page builds itself load their images, scripts and
  stylesheets through the proxy. Chrome hands an about:blank frame or popup
  no service worker, whether the page writes into its first document, opens
  it or navigates it to about:blank (measured in plain Chrome 152; a srcdoc
  frame it does), so every element load in one reached the proxy origin's
  own server and failed: the content of editors, ad slots and widgets built
  that way. In such a document (no controller, and about:blank or opened)
  an image, srcset, image input, script, stylesheet, poster or media source
  is now fetched through the proxy and given a blob: copy, written under the
  hooks; the attribute, the property, currentSrc and the markup read back as
  the page wrote them. A property set no longer writes an emptied URL back
  (a script then failed for good). The url()s inside such a stylesheet, CSS
  in style attributes and fonts are not covered yet. WPT's fetch-metadata
  element-img-environment-change no longer hangs (blank-loads suite, both
  modes, against the page loaded natively).
- A download link whose click handler stops the click's propagation still
  saves what the site serves. The proxy's copy was started from the window
  at the end of the click, which such a handler never let it reach, and the
  browser's own (broken) download went ahead. The browser's download is now
  cancelled as the click starts and the copy saved once every handler ran,
  unless one cancelled it; until then the page reads `defaultPrevented` and
  `returnValue` as its own calls left them (download suite, both modes,
  against the page loaded natively).
- A popup opened without a URL, and a new frame, read their location as
  `about:blank`. A window the page injects itself (its about:blank document
  runs the opener's inject bundle) read the bundle's own window's location,
  so `popup.location.href` and a fresh frame's `contentWindow.location.href`
  showed the opener's URL (window-identity suite, both modes, against the page
  loaded natively).
- A link with a `download` attribute saves what the site serves. Chrome
  hands no download to a service worker, so the browser fetched the routed
  URL from the proxy origin's own server: the download was its 404 page,
  named after the route, and was cancelled. A same-origin download (the only
  kind the attribute applies to) is now fetched through the proxy and saved
  from a blob: URL under the name the browser picks on the real site (the
  attribute, the Content-Disposition, or the URL's last segment); the page's
  own click handlers run first and can cancel it. WPT's fetch-metadata
  element-a and element-area pages no longer hang (download suite, both
  modes, against the page loaded natively).
- A window keeps its identity when it navigates to another site. The page
  got a window as itself while it was of its origin (the popup
  `window.open()` returned, a frame's `contentWindow` read before the frame
  loaded) and as a restricted stand-in once it was not, so a message's
  `event.source`, a later `contentWindow` and `opener` were another object
  than the one the page held: the common check `event.source === popup` (an
  OAuth or payment popup, an embed's frame) never matched, and WPT's
  fetch-metadata window-location and form-submission pages hung on it. A
  window the page already holds is now handed back as itself wherever it
  goes; that gives the page nothing it did not have (window-identity suite,
  both modes, against the page loaded natively).
- A module worker's imported modules run with the hooks in place. A module
  worker loads the client from the top of its own body, but its static
  imports are evaluated before that body runs, so a request an imported
  module made at the top level (a `fetch` built on `import.meta.url`) went
  straight to the site. Every static import of a worker module is now routed
  as a worker module, and whichever module of the graph runs first loads the
  client, once (bypass-relative and rewriter-unit suites).
- A page's `<base href>` applies to its own markup. The page loader routes
  every URL in the markup before writing it, when the base element is not in
  the document yet, so every relative URL in the page (stylesheets, images,
  srcset, media, SVG references, frames, forms, pings, inline module imports,
  the import map) resolved against the page's URL instead of its base; and
  the base's own href, and its `href` property, resolved against the base URL
  in force rather than the document's URL. The loader now resolves the markup
  against the first `<base href>` it holds, and a base's href against the
  document's URL (bypass-relative suite).
- An SVG `<use xlink:href>` with a relative URL is routed. The hooked
  `setAttributeNS` (which the page loader also uses for every namespaced
  attribute in the markup) wrote the page's value first and routed it after,
  and a `<use>` fetches its reference the moment the attribute lands: the
  relative URL was requested against the document's route, a path on the
  proxy origin that names nothing. A hooked attribute is now created empty
  and the value written through the hooks, as `setAttribute` does
  (bypass-relative suite).
- A script reads back the source the page wrote when `document.write`,
  `innerHTML` or `insertAdjacentHTML` made it, when its text was set while
  it was connected, and when it is an SVG script; each read back (and
  serialised as) the rewritten code. A script `document.write` wrote was
  even rewritten twice, so its own `document.currentScript.text` was the
  first rewrite (markup-parity, readback suites).
- Every element reads its attributes back as on the real site (found by
  the new markup-parity suite, which compares the corpus pages and the
  attribute fixtures loaded natively and through the proxy, in both modes).
  `setAttribute('HREF', x)` on an HTML element skipped the hooks (they are
  keyed by the lowercase name), so the link went out raw and read back its
  previous value. An attribute a hook drops (an object's `data` placeholder,
  an iframe's `sandbox`) was missing from `getAttributeNames()` and
  `attributes`, and serialised after the attributes written later.
  `attributes['s_o:href']`, `getAttribute('s_o:href')` and a marker name in
  capitals still answered.
- A page's MutationObserver sees the attribute writes it made, not the
  proxy's. Each routed attribute keeps the page's value in an `s_o:` marker
  next to it, and one write by the page is several native ones (the routed
  value, the marker, the property applied again), so an observer got records
  named `s_o:src` and `oldValue`s holding routed URLs, which frameworks and
  analytics read. Observers now get one record per write, named for the
  attribute, with the value the page saw before as its `oldValue`; the
  hooks' own writes (routing an inserted element) make none, `takeRecords()`
  answers the same, and a callback left with no record is not called.
  Corpus: attrs 2 failing checks to 0 (scramjet fails this one too);
  markup-parity compares every record with the page loaded natively.
- A link's ping goes through the proxy. `<a ping>` and `<area ping>` were
  not routed: a ping to another origin reached the site straight from the
  browser, past the proxy, and its Ping-From and Ping-To headers named the
  proxy's own address and routes; a relative ping was lost. Every URL in the
  attribute is now routed (the page reads it back as written) and the worker
  rewrites Ping-From and Ping-To to the real URLs. Found by the new bypass
  suite, which fires every request API and loading element in a proxied page
  and fails on any request that reaches the network without the proxy, in
  both modes (bypass suite).
- A URL property whose attribute is missing or empty reads back as on the
  real site, never as the proxy's address. A form without an action got a
  routed one the page could read (`getAttribute('action')`, `outerHTML`):
  Last.fm's pjax submits a form to `$form.attr('action')`, so its sign-in sent
  the proxy's raw URL on, which was routed again and refused (the route of a
  route is now the route, so it lands, but the page still saw the proxy). Such
  a form now keeps no action and submits to the document's own address, whose
  query a GET submission replaces as the browser would. `form.action`,
  `formAction` and `base.href` without an attribute, and an empty `href` or
  `src`, read the document's URL or its base URL, and setting one to `''`
  leaves it empty (url-defaults suite, both modes, against the page loaded
  natively).
- A route of a route is the route. A page that got hold of its own raw
  proxy URL (a read the rewriter missed) and handed it to a link, a form
  action or `location` had it routed again, and the worker refused the result
  as its own origin: a Last.fm sign-in on Fracital ended on the error page,
  kind `refused`. Every routing hook now unwraps a URL that is already a route
  of the scope (any controller id and kind, any depth) and routes the real URL
  it stands for, and the worker answers a request for a double route with a
  307 to the single route, documents and subresources alike. Only a genuine
  own-origin URL is still refused. The page reads such a link back as it wrote
  it (double-route suite, both modes).
- Documents a page makes itself load their subresources through the proxy. A
  `javascript:` URL's string, a `text/html` blob shown in a frame and a
  `data:` frame became documents no service worker controls (Chrome does not
  hand them the creator's), so their images, scripts, stylesheets, fonts and
  XHRs reached the proxy origin's own server and failed (nothing went to the
  site). They are now inline documents: the page registers the markup with the
  worker under a single-use random token (from a document of the same
  controller, at most 4 MiB, expiring in seconds) and the frame navigates to
  `<address>inline:<token>/...`; the worker rewrites the markup itself as for
  any fetched page and serves it, so the document is controlled, with the
  referrer policy its creator's navigation carries. A `javascript:` URL's
  document is a raw bootstrap that replaces itself with it. An unknown, used
  or expired token gets the error page. Readbacks are as before (a data: frame
  is origin `"null"`, a blob document shows the page's URL), and a document
  whose URL is not http(s) sends no Referer, as the spec's strip rule says. An
  `<object>` or `<embed>` document cannot be made controlled (Chrome never
  hands their loads, or their documents' own navigations, to a service
  worker): its fetches go through the page, its markup subresources and XHRs
  still miss the worker (inline-documents suite, both modes).
- A `data:` frame runs proxied, as the opaque origin it is. Its document has
  an opaque origin the inject could not reach: its requests had nowhere to go
  and its messages never arrived. A `data:text/html` frame now loads from a
  blob: URL of the shell with the data: URL as its document's URL, so it runs
  injected while every readback treats it as origin `"null"`: its `origin`,
  `location.origin` and messages say `"null"`, `location.href` is the data:
  URL, `document.domain` is empty, and the page and the frame see each other
  through the restricted cross-origin stand-ins (`contentDocument` null,
  `SecurityError` on reaching the other's document). The page never injects
  such a frame itself. This is the same best-effort footing as every proxied
  cross-origin frame in same-origin mode, not the browser's isolation.
  Requests from a document no service worker controls go through the nearest
  controlled ancestor, by each client's own parent, and without a referrer
  where the document's own default is none (data:, and the about:blank a
  `javascript:` URL's document keeps); an explicit `referrer` of the page's
  origin is sent in proxy space, so the browser honours it (data-frames
  suite, both modes; wpt-referrer-policy: the inheritance pages, 7 more
  subtests pass).
- `postMessage` honours the target origin between proxied windows. Every
  proxied window shares the proxy origin, so the browser's own check let any
  `targetOrigin` through: a message aimed at one origin reached a frame of
  another. The target is now compared with the receiver's real origin (`*`
  any, `/` the sender's own, `"null"` never matches) and an invalid one is the
  browser's `SyntaxError` (data-frames suite).
- The shell writes a blob document's URL into its first script with `<`
  escaped: a URL holding `</script>` (a data: document's markup) ended that
  script early and the document lost its URL.
- `<object data>` and `<embed src>` load through the proxy. Chrome never
  routes their loads through a service worker, so the routed URL reached the
  proxy origin's own server and the element showed nothing (a page, a PDF or
  an image alike). The inject now fetches the resource through the proxy and
  hands the element a blob: URL of it: HTML wrapped in the shell like a blob
  document (its real URL as base), anything else as it came. The element has
  no URL until then (an empty one makes an object show its fallback and stop
  loading), a value set again keeps the load in flight, a later value wins,
  and a failed fetch falls back to the routed URL. `data` and `src` read back
  as written (frames-objects suite; wpt-referrer-policy:
  `unsupported-elements`, 4 subtests from timeout to pass).
- A transport is initialised once at a time. Every port served from one
  transport (the service worker's, each page's) called `init()` for every
  request that found it not ready, so a burst at start-up initialised it
  several times at once; epoxy's `init()` loaded its wasm again on each call,
  and two same-tick calls killed the first client. All callers now wait on
  one in-flight `init()` per transport, and a failed one is not kept, so the
  next request tries again (transport-init suite).
- A frame whose document a `javascript:` URL's string makes runs proxied.
  `<iframe src="javascript:'<p>...'">` (and a link or `location` set to such
  a URL) replaces the document with the string's markup, which nothing
  injected: its scripts ran raw, saw the host as `top` and posted to it. A
  single-expression `javascript:` body now hands a string value to the
  client, which wraps it in the shell like a blob document; statements and
  other values are left as they are. Such a document is not controlled by the
  service worker, so the inject sends its routed fetches through the nearest
  controlled ancestor, and a fetch's response URL is read back through the
  client rather than the bundle's own `location` (links suite, rewriter-unit
  shape; wpt-referrer-policy: the two `javascript:` inheritance pages report
  instead of timing out).
- The cookie jar parses a line the way Chrome does. A control character
  anywhere in it (an attribute value included, `Domain=localhost\x01`) drops
  the whole cookie; only the name and value were checked, so the cookie was
  stored without that attribute. A response header reads a NUL as a space and
  ends at a bare CR or LF, as Chrome's HTTP parser reads it. An attribute
  value over 1024 bytes is skipped, so an earlier Path or Domain still counts
  (the oversize one won). A nameless cookie whose value starts with
  `__Secure-` or `__Host-` is refused, since it would pass for that cookie.
  One Set-Cookie value (or one `document.cookie` write) is one cookie: the
  parser split it at commas, so `test=1, baz=qux` lost everything after the
  comma. A cookie set again with a new value is a new creation and moves
  behind the other cookies of its path, as in Chrome (the same value keeps
  its place); a nameless cookie set again stayed first (cookie-jar and
  cookie-rules suites; wpt-cookies, with the test-driver shim fixed too:
  `attributes-ctl.sub.html` from 4 to all 423 natively passing subtests,
  the whole suite from 305 of 764 to 851 of 860).
- `document.cookie` on a document without a browsing context (one a
  navigation replaced, one from `createHTMLDocument`) reads `""` and ignores
  writes, as in a browser; it threw "Illegal invocation" because the hook
  accepted only the window's current document (wpt-cookies:
  `navigated-away.html`).
- A rewritten `x.postMessage(...)` on a null or undefined `x` throws the
  TypeError the original call throws ("Cannot read properties of null
  (reading 'postMessage')"), not "Function.prototype.apply was called on
  undefined" from inside the access API. testharness's
  `fetch_tests_from_window(window.open(...))` hits it when the host hands
  popups to its own tabs and the page gets null (rewriter-unit shape).
- Upstream servers saw Fetch Metadata describing the service worker's own
  fetch rather than the page's request. Sec-Fetch-Mode was guessed from the
  destination (`no-cors` for a crossorigin image or script, a module import,
  a font; `cors` for a `same-origin` or `no-cors` fetch), and Sec-Fetch-Site
  was `none` whenever the referrer did not name the page (a dynamic import,
  whose referrer is the inject bundle; a fetch under `no-referrer`) and
  `same-origin` at the end of a redirect that had left the site. The worker
  now rebuilds the four headers as Chrome does for the real origins: the
  mode is the request's own, the site compares the request's client (the
  document or worker, not the stylesheet or module that named the URL) with
  the target, schemefully and by registrable domain with the private
  registries, widened over every redirect of the chain (the redirect memo
  that carries the Referer to the next hop carries the site too); the
  destination is `document` for the page's top-level navigation, and `none`
  with Sec-Fetch-User is left to the navigation the user starts from the host.
  Sec-Fetch-Site no longer walks a nested frame's ancestors (the cookie
  jar's site still does), Origin follows the request's mode, an http origin
  that is not potentially trustworthy gets no fetch metadata, and a
  synchronous XHR names its document as the initiator. The headers suite
  compares each request kind with the native page's; wpt-fetch-metadata
  drops 92 expected failures. A blob: worker's requests are still taken as
  same-origin, and a navigation a page starts under user activation still
  lacks Sec-Fetch-User (the worker sees neither).
- A `Refresh` response header refreshes the page. The browser schedules a
  header refresh on the document it creates for the response, and the shell
  re-opens that document to write the page, which drops it: the page stayed
  where it was. The worker now carries the header into the markup as a meta
  refresh right after the doctype, which the inject routes like any meta
  refresh the page wrote (refresh suite; wpt-referrer-policy: the three
  `refresh-*` pages, 46 subtests from timeout or not run to pass).
- A link or `window.open` aimed at a frame of the page by name navigates that
  frame. With a host that handles new tabs (`onOpen`), every target outside
  `_self`, `_top`, `_parent` went to the host as a new tab, including the
  name of an iframe the page owns, so the frame never loaded and the host
  opened a tab instead (the WPT referrer-policy `a-tag` pages, whose links
  target a named iframe, never reported). A target that names an iframe or
  frame of the page now stays with the browser, which navigates that frame
  (links suite; wpt-referrer-policy: 111 `a-tag` subtests from timeout to
  pass).
- A proxied document's `document.referrer` follows the referring page's
  referrer policy. The browser applies the policy in proxy URL space, where
  every page shares the proxy origin, so it keeps the full routed URL, and the
  inject decoded that: a frame on another origin saw the full referring URL
  where its header, meta tag, `referrerpolicy` attribute or the default
  (`strict-origin-when-cross-origin`) said origin only or nothing. The
  service worker now hands each document it serves the referrer it computed
  for the real origins (the function the Referer header already used, moved
  to `src/referrerPolicy.ts`), and when the browser sent only the proxy
  origin (`origin`, `strict-origin`) a nested document applies the policy to
  its parent. The worker also remembers what each redirect it answered sent,
  so a chain through another origin stays narrowed on the next hop for the
  header too (wpt-referrer-policy at concurrency 1, iframe-tag, script-tag,
  xhr, img-tag and fetch: 196 proxied failures to 0; referrer suite:
  no-referrer, origin, cross-origin strict-origin-when-cross-origin and
  unsafe-url frames match native ones).
- `new Request(request)` keeps the request's URL. The Request constructor
  hook resolved its first argument as a URL string against the page, so a
  Request given a Request (what `fetch(new Request(req, init))` and libraries
  that copy requests do) asked for `/[object Request]` on the page's origin
  (Last.fm's request log showed the 404s). A Request input is now copied as
  the browser copies it; strings and URLs resolve as before (page-apis
  suite).
- A `data:` script, stylesheet or document whose body holds a `?` is rewritten
  whole. The URL parser files everything from the first `?` of a data: URL
  under `search`, and the rewriters read the data from `pathname` only, so a
  body with a query in it (`data:text/javascript,import("https://x/s.py?a=1")`,
  what the WPT referrer-policy dynamic-import pages do) was cut there, failed
  to parse and ran as written, with a SyntaxError in the page. The data is now
  everything after `data:` but the fragment (wpt-referrer-policy: the 30
  `script-tag-dynamic-import` pages, 384 subtests, from every scenario
  rejecting to all passing; rewriter-unit shape).
- A host page controlled by the host's own service worker boots. Our
  worker's startup revive (or any message carrying the `$stomp$swRevive`
  key) that arrived before the first handshake, which a descriptor transport
  delays while its worker imports the module, made the controller adopt
  `navigator.serviceWorker.controller`; on a page the host's root worker
  controls that is the foreign worker, and the handshake went there forever:
  `wait()` never resolved on live Fracital with a fresh profile. The revive
  handler now ignores a revive before the first handshake, acts only on one
  whose source is a worker served from the directory, adopts the page's
  controller only when it is one of ours and otherwise keeps the
  registration's active worker; the `controllerchange` handler already
  applied that test, and the registration lookups are scoped to the
  directory (foreign-sw suite: a host page under a foreign root worker, a
  fresh registration and a descriptor transport, broadcasts during startup
  and later; the controller stays on its worker, `wait()` resolves, a frame
  loads).
- A large `localStorage` value stores. The synchronous bridge carries a
  page's `localStorage` calls to the worker in a beacon, which the browser
  refuses over 64 KiB (and the quota is per document while the page's thread
  spins, so no number of beacons helps; a sync XHR never reaches a service
  worker in Chrome), so `setItem` with a large value (Wikipedia's) threw
  `QuotaExceededError`. A write the bridge cannot carry is now kept as the
  document's own view of that key and sent to the worker asynchronously, in
  order; the writer reads it back, lists it and can remove it at once, later
  operations on a key with a write in flight queue behind it, and other
  documents see the value once it is stored (storage-events suite: a 200 KiB
  and a 2 MiB value).
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
  document: a nested cross-site frame gets `SameSite=None` cookies only,
  while a top-level cross-site navigation of the page still carries Lax
  (Sec-Fetch-Site does not walk the ancestors, see the fetch metadata fix). The kind is decided in the page realm, so a page
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
- Two epoxy hangs, fixed by two more patches in `deploy/epoxy/` (once
  published and pinned). Requests that started in one tick on a cold
  transport lost all but one: each called `init()`, epoxy instantiated its
  wasm module once per call, and the client built on the replaced instance
  never answered ("memory access out of bounds" in the console); epoxy now
  loads once however many requests wait for it. And a request to an origin
  that had closed an idle keep-alive connection (node closes after 5 s) hung:
  wisp's stream close never left its queue, so hyper's pool kept the dead
  connection and handed it out; the close now goes out and the pool drops the
  connection. Measured by the new `epoxy-concurrency` suite (2, 4 and 8
  same-origin navigations, fetches and raw transport requests at once, and
  again after the idle timeout; libcurl on a real site as the control).
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

- A page that races its own parser against an async script loses that race
  more often through the proxy, because its parser-blocking scripts arrive
  later: each is rewritten in the service worker, and Chrome fetches every
  script its preload scanner found in a `document.write`d document a second
  time when a service worker controls it (measured with a pass-through
  worker and no Stomp). The TinyMCE docs page sets `piAId = ''` at the end of
  its body while Google Tag Manager's page-view tag sets the Pardot IDs as
  soon as gtm.js arrives; natively the parser wins by about 40 ms, so a
  throttled native load (150 ms latency) clobbers the IDs too, and Pardot
  answers `campaign_id=null` with an HTML refusal its script tag cannot
  parse. Nothing in the rewrite is involved: sloppy global writes, script
  order and GTM's inserted scripts behave as natively.
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
- A request that starts just as the server closes its idle connection fails
  with an error rather than being retried on a new connection the way Chrome
  retries it (the pinned epoxy no longer hangs there; hyper does not retry).
- epoxy (hyper) refuses a whole response whose header holds a NUL, CR or LF,
  where Chrome reads a NUL as a space and a bare CR or LF as the end of the
  header, and the service worker answers that fetch with a 500 rather than
  a network error (wpt-cookies: the `%x0 in name (HTTP)` and `value after
LF` cases).
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
