# Agent guide for @sysce/stomp

This file is for AI coding agents (and humans) working in this repository.
Read it before changing anything.

## Ground rules

- **Never commit or push on the user's behalf unless they explicitly ask for
  it in the current turn.** "Fix the bug" is not authorization to commit.
  "Commit this" or "push it" in that same message is. Approval given earlier
  in a session does not carry forward. Leave work in the working tree and say
  so in your summary.
- Never rewrite history, force-push, delete branches, or change remotes
  unless the user explicitly asks for that in the current turn.
- Commits must not carry AI attribution. No `Co-Authored-By: Claude ...`
  (or any other model/agent) trailer, no "Generated with ..." lines in commit
  messages or pull request descriptions. The author is the user; the commit
  message describes the change and nothing else. This overrides any default
  attribution an agent harness tries to add.
- Don't publish to npm.
- Keep the working tree reviewable: don't reformat files you didn't otherwise
  touch, and don't bump dependency versions that the task doesn't need.
- Report what you verified and how. If a check didn't run, say that it didn't.

## What this project is

Stomp is a web proxy. The service worker (`src/server/`) rewrites HTML, CSS and
JavaScript; an inject bundle (`src/inject/`) runs inside every proxied page and
worker and hooks the DOM and JS globals so the page believes it is on its real
origin; and a controller (`src/controller/`) running in the host page owns the
network transport and shows proxied content in frames.

Traffic goes through a `@mercuryworkshop/proxy-transports` transport (epoxy or
libcurl, tunnelled over wisp). The transport lives in the controller page; the
service worker and every proxied document/worker reach it over MessagePorts
(`src/transport/`). No page ever loads the transport module itself.

```
src/
├── controller/     StompController, Frame (public API; dist/controller.mjs)
├── transport/      RpcHelper, RemoteTransport (client side), serveTransport (host side)
├── server/         service worker: router, rewrites, cookies, storage, sync bridge
├── inject/         page/worker clients and hook modules (dom/, worker/, modules/)
├── rewriteHTML.ts, rewriteCSS.ts, rewriteJS.ts, routeURL.ts, Codecs.ts, StompURL.ts
└── bootstrapper/   SearchBuilder
demo/               Express + wisp host app (npm run demo), documented in demo/README.md
build.js            esbuild entry points (and the rewriter library, see below)
```

## Commands

```sh
npm install
npm run check     # tsc --noEmit
npm run lint      # eslint
npm run build     # check + esbuild + declaration emit -> dist/
npm run dev       # esbuild watch
npm run demo      # http://localhost:8080 with wisp, epoxy and libcurl
npm run format    # prettier --write .
```

`npm run build`, `npm run lint`, `npx prettier --check .` and
`npm run check:prose` must all pass before you call a change done. There is
no unit test suite; see Verification.

### Dev loop

`npm run dev` (`scripts/dev.mjs`) runs the esbuild watch and the demo server
(`STOMP_DEV=1`, `node --watch`) together with live reload: `build.js` reports
each rebuild to `POST /__dev/changed`, the server pushes it and `demo/public`
edits over the `/__dev` WebSocket, and `demo/public/pm/dev.js` applies them
(css swapped in place, inject bundles reload the proxied frames, the service
worker is updated and the controller re-handshaked, anything the host page
runs reloads the page, build errors show an overlay). Every step prints a
`Dev` console badge and `window.__stompDev.state` holds the client state. All
of it is gated on `STOMP_DEV`; production serves none of it. Never run the
watcher against a checkout another process is testing: it rewrites `dist/`
on every save (use a `git worktree`).

## Things that will bite you

- **esbuild `inject` replaces free globals.** `src/inject/snapshot.ts` and
  `src/inject/dom/snapshot.ts` export `fetch`, `Request`, `Reflect`,
  `WebSocket`, `navigator`, ... and `build.js` injects them into the inject
  bundles, so any unqualified use of those names anywhere in that bundle
  (including node_modules) gets the pristine copy taken before the page ran.
  Write `globalThis.X` when you really want the live global.
- **The inject's rewriter is a library of its own, often in a detached
  realm.** meriyah, escodegen, css-tree and tldts reach the inject only
  through `src/inject/rewriter.ts` (light code reaches modifyJS/modifyCSS
  through `src/rewriters.ts`). A proxied top evaluates the library in a
  removed about:blank frame and its frames share that copy
  (`src/inject/dom/rewriterRealm.ts`). A removed frame's realm still runs
  code, but its DOM globals answer `undefined` (structuredClone silently
  returned undefined there and broke every shorthand property): anything
  the library reads from the window must be taken in `src/libGlobals.ts`.
  Only strings, numbers and booleans cross; the library never calls out.
- **Classic-script globals use `Reflect.defineProperty`, not `globalName`.**
  The inject bundles delete `createClient` after use; a top-level `var` from
  esbuild's `globalName` can't be deleted. See `src/*/entry.ts`.
- **`usePrototype` swaps an element's prototype while hooks run.** Pending
  attribute writes are applied only after the real prototype is restored,
  because custom element reactions fire synchronously and expect the real
  `this`. Don't move that order (`src/inject/modules/Proxy.ts`).
- **`window.top` is unforgeable.** It is handled by the JS rewriter's access
  hook (`client.resolveTop`), not by a property hook. `set2` also routes
  `obj['top'] = v` through `api.get`, so anything there must check it is
  dealing with a Window.
- **Attribute hooks run after each `setAttribute`, including our own.** A hook
  that stores the "original" value must recognise values it wrote itself
  (see the form `action` hook). `'*'` is a valid tag for `useAttributes`.
- **Chrome exposes `element.style.x` as per-instance named setters.** They are
  intercepted with a Proxy returned from the `style` getter
  (`src/inject/dom/modules/DOMAttributes.ts`), not prototype accessors.
- **Rewritten inline scripts are serialized back into HTML.** Anything that
  can produce `</script` in generated code must escape it (`loadHTML`).
- **Every function the rewriter prints carries a mark** (`/*key.start.len*/`
  right after its first token, `src/functionSource.ts`): the toString hook
  reads the page's source back by it. A new rewrite that rebuilds a function
  node must keep the original node (its `range`), and a check on exact
  rewriter output strips marks first (rewriter-unit's `unmarked`).
- **Inline `<script type="module">` and `src` set before `type`** need the
  module goal; both are handled, keep it that way.
- **Optional chaining** through a computed member is rewritten to
  `$s$j.get2(obj, key, partial, true)` and the rest of the chain is marked
  optional; a key or call argument that does work goes in an optional call
  instead (`$s$j.lazy(obj)?.(key)`, `method`, `poster`), because a helper's
  arguments are evaluated before it can short-circuit. Any new access
  rewrite must preserve short-circuiting.
- **The sync bridge (`src/inject/dom/modules/Sync.ts`) spins the main thread**
  waiting for the service worker via cookies. The deadlock only exists with
  an in-page transport: a ProxyTransport instance (or a descriptor with
  `host: 'page'`) is served from the host page's thread, which the spinning
  frame shares in same-origin mode, so a synchronous request that needs the
  network waits out the spin limit. A descriptor (the default) runs the
  transport in the transport worker (`src/transport/worker.ts`), off that
  thread, and the request completes. Don't add new synchronous paths.
  The beacon that carries a request is capped at 64 KiB per document and per
  synchronous call, and a beacon's completion is a main-thread task the
  spinning page never runs, so a request over the cap cannot be split across
  beacons. The bridge counts the beacons it has in flight (`BEACON_QUOTA`),
  and the storage module sends a write that would take them past its
  budget (a large value, or a medium one after others in a burst) with the
  async fetch instead: shadowed for the writer, numbered so the worker
  applies them in order, sent at once so an unload does not lose them. Which
  operation it is (sender, number, key) rides in the URL, so the worker knows
  of it before its body is read and every other storage call of the origin
  waits for it (bounded at 6 s, after which its key is emptied, never read as
  the value it replaced); the worker keeps a document's place in the sequence
  for minutes after it goes idle. The budget leaves room for reads, which
  have no other way. An answer rides in cookies, about 180 per host, so a
  value is read back in parts. The cookie module does the same with a
  `document.cookie` write the bridge cannot carry (the page's own beacons
  share the quota): numbered, applied to the document's view of the jar at
  once, and every read of the jar in the worker (Cookie headers included)
  waits for the writes it heard of.
- **One controller per address, many per scope.** `config.directory` is a
  controller's address: the directory the host gave plus `controller.id`
  (`/stomp/k7qx2m/`). Every routed URL starts with it and the service worker
  finds the controller by it (longest prefix), so two host tabs on one
  directory are two controllers; the same id again replaces. `config.scope`
  (`/stomp/`) is the service worker's scope and the only thing the asset URLs
  (inject bundles, the transport worker, the controller frame) are built
  from (`assetBase` in `src/routeURL.ts`). A controller is a tab, not a
  browser: the cookie jar, the HTTP cache and the storage partitions are
  opened once per scope and shared (`sharedStores` in `createServer`). An
  address whose controller is gone is redirected to the newest live
  controller of the scope with the same codec (the worker keeps each
  address's codec in `stompConfig`); with none, the host's error page
  answers with kind `controller`.
- **Same-origin `StompController` is for development only.** It is not a
  security boundary: a proxied page is same-origin with the host. Real
  deployments use `RemoteController` with a separate proxy origin
  (`src/controller/remote.ts` on the host, `src/controller/frame.ts` in the
  controller frame). The "this page is top-level" spoof hooks live in
  `src/inject/dom/modules/Framing.ts`; it must be added before `ContextModule`
  because it captures the native `MessageEvent.source` getter, and anything
  it registers on `window` must be re-registered through
  `addDocumentOpenListener`, since `document.open()` drops window listeners.
- **Cross-origin named frame access is blocked by Chrome.** The controller
  frame reaches sibling proxied frames by index into the host's `frames`
  list, which is in creation order, not document order; the host computes
  the index by comparing window proxies.
- **Prettier 3 formats with trailing commas and reflows strings.** If you
  patch files with scripts, read the current text first.

- **An IndexedDB transaction commits during any foreign `await`.** In
  `createServer` (and anywhere a transaction is open) nothing but the store's
  own requests may be awaited before `tx.done`; awaiting `caches.delete`,
  `fetch` or a timer in between makes the next store call throw
  `TransactionInactiveError`, and because that happens while the service
  worker builds its server, the page sits on "Waiting for the service worker"
  forever with nothing in its console.

## Transports (measured, see CHANGELOG known limitations)

- epoxy 3.0.2: HTTP solid, incoming WebSocket frames stop after the first
  round trip (against wisp-js 0.5). It is installed from our own build, not
  npm: `deploy/epoxy/` pins the upstream revisions and carries the patches
  (hyper-util-wasm exposes the HTTP/2 header-list limit, epoxy-tls sets it to
  256 KiB like Chrome; the npm package's 16 KiB resets YouTube with
  `PROTOCOL_ERROR`). `build.sh` builds it in a container, `publish.sh` pushes
  the result to the `dist` branches of `Fracital/epoxy-tls` and
  `Fracital/EpoxyTransport`, and `package.json` pins that commit by
  `git+https://` URL. Read `deploy/epoxy/README.md` before touching any of it.
- Hosts install stomp from npm as `@sysce/stomp`. `.github/workflows/nightly.yml`
  publishes master as `@sysce/stomp@nightly` every night (and on manual
  dispatch) once CI passed on that commit, through npm trusted publishing
  (OIDC, no token in the repository) with provenance. There is no `dist`
  branch any more; hosts pin an exact nightly version.
- libcurl-transport 2.0.6: WebSockets fine, HTTP stops answering after ~70
  requests (default pool) or ~160 (`connections: [500, 400, 200]`).
- HTTP/3 is opt-in (`TransportDescriptor.http3`, `src/transport/http3/`):
  QUIC over epoxy's wisp UDP streams through stomp-h3 (`deploy/epoxy/h3/`,
  our own crate built into epoxy-transport's `dist/h3/`, not an upstream
  patch). The wisp server must relay UDP; the holyWisp edges do not.
  docs/http3.md.

When a site hangs or a socket goes quiet, suspect the transport before the
rewriter: reproduce with a raw `controller.transport.request()` /
`.connect()` loop from the controller page, with no Stomp in the path.

## CI

`.github/workflows/ci.yml` runs on every push to `master` and every pull
request: `npm ci --ignore-scripts`, `npm run check`, `npm run lint`,
`npx prettier --check .`, `npm run check:prose` (no em dashes, no AI
attribution; the same script checks a PR's commit messages) and the esbuild
build. All of it must pass locally before you push. A `browser suites` job
runs `npm test` on the runner's Chrome with `SKIP_NETWORK=1` (the suites
that drive Wikipedia stay out), `SKIP_TIMING=1` (the flick-velocity suite)
and `SKIP_MEASUREMENT=1` (the adversarial corpus, the vendored
web-platform-tests, which report every known leak and expected failure on
purpose, and the `measure-*` timings) and `PARALLEL=2`; since 2026-11-07 it is
required by branch protection, so a suite that cannot pass on the runner
goes behind one of those flags rather than staying red (a per-frame animation
measurement reads `SKIP_TIMING` itself and keeps only its final-position
assertion there).

Rules for touching the workflow, because a PR from anyone runs it:

- Keep the trigger `pull_request`. Never use `pull_request_target`, and never
  check out a PR head inside a workflow that has secrets or write permission.
- Keep `permissions: contents: read`. The workflow never commits, comments or
  pushes; formatting is the author's job.
- Pin every action to a full commit SHA with the version in a comment.
  Dependabot (`.github/dependabot.yml`) proposes bumps.
- Keep `--ignore-scripts` on install.
- Never interpolate titles, bodies, branch names or other user-controlled
  event fields into `run:` scripts. Pass them through `env` if you must.
- Repository settings that back this up (set through the API, not files):
  workflows get read-only tokens by default, first-time outside contributors
  need approval before any workflow runs, and `master` requires the CI
  checks to pass before a pull request merges.

`.github/workflows/deploy.yml` deploys every push to `master` to
https://stomp.fracit.al (terp, pm2 app `stomp` on :8081, behind OpenResty and
the abulxt edge fleet). Its only secret is `TERP_DEPLOY_KEY`, an SSH key that
terp restricts to `/usr/local/sbin/stomp-deploy-gate` (source:
`deploy/terp-deploy-gate.sh`, installed by hand). The gate accepts exactly
`deploy <sha>` and refuses if the live checkout has work that is not on
GitHub. It runs on `push` only, so pull requests never reach the key. Server
settings live in `/opt/stomp/repo/.env` on terp (`PORT`, `STOMP_WISP_URL`
pointing at the edges' keyed holyWisp relay on holywisp.fracit.al); CI never
touches it. The OpenResty
vhost and the edge server names are managed by abulxt's ansible
(`fracital_origin_apps`, `fracital_extra_hosts`), not by this repo.

## Verification

There is no unit test suite; the browser suites in `test/` are the test
suite, and they run against the real thing:

1. `npm run build && npm run lint && npx prettier --check .`
2. `npm test`: every suite in `test/suites/` gets its own demo server
   (`WISP_ALLOW_LOOPBACK=1`) and fixture site on free ports, so runs never
   collide with a dev server; four suites run at once by default
   (`PARALLEL=1` streams one at a time, `npm test -- back escapes` picks
   suites). It drives the system Chrome through playwright-core with
   `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost` so any request
   that bypasses the proxy fails loudly. Suites sharing one server starve
   each other on its wisp and fail spuriously; never point two at one server.
   `backwalk` walks real Wikipedia pages and is timing sensitive. It is not in
   CI (needs Chrome and network on the runner).
   The `wpt-cookies`, `wpt-fetch-metadata` and `wpt-referrer-policy` suites
   run the web-platform-tests vendored under `test/wpt/` (see its README)
   natively and through the proxy and compare the two verdicts per subtest
   against `test/wpt/expected/<suite>.json`. They are measurements: a
   proxied failure not on the list fails the suite, and so does a listed
   failure that now passes. After a fix, run the suite with
   `UPDATE_EXPECTED=1` to rewrite its list and commit the trimmed file with
   the fix; `node test/wpt/refresh.mjs <checkout>` refreshes the vendored
   tree from a sparse upstream clone.
3. Useful probes, in order of cost: a proxied frame's `document.title` and
   element count; `frame.url`; a WebSocket echo against a local `ws` server;
   a fixture site that exercises cookies, headers, redirects, XHR, history,
   storage, iframes, workers, EventSource, forms and inline styles; then real
   sites (Wikipedia, GitHub, MDN, Hacker News render; many others bot-block
   headless browsers, which is not a Stomp bug).
4. For "did the proxy leak the origin", read attributes with the parent
   realm's `Element.prototype.getAttribute.call(el, name)`: the page's own
   `getAttribute` is hooked to return the original value.

## Style

Prettier (`.prettierrc.json`) and ESLint (`eslint.config.mjs`) are the source
of truth; `npx prettier --check .` and `npm run lint` must pass. On top of
what they enforce:

**Formatting**

- Tabs for indentation, single quotes, semicolons, trailing commas
  everywhere (prettier 3 defaults plus `useTabs` and `singleQuote`).
- Imports sorted by `@ianvs/prettier-plugin-sort-imports`; let prettier do it,
  don't hand-order them.
- Lines wrap at 80; prefer breaking a long call into one argument per line
  over a clever one-liner.

**Language**

- ES modules only. No CommonJS in `src/` or `demo/public/`; `lib/index.cjs`
  is the one deliberate CJS file (it exports `stompPath` for Node hosts).
- `const` by default, `let` when reassigned, never `var` (lint error).
- `===` always (lint error). Compare against `null`/`undefined` explicitly
  rather than with `== null`.
- `async`/`await` over promise chains; `.then()` only where a callback is
  genuinely fire-and-forget.
- Arrow functions for callbacks; `function` declarations for hoisted helpers
  and anything that needs its own `this`.
- Class private state uses `#fields`; avoid `private` TypeScript-only members
  for anything a page could otherwise reach.
- `type` imports for type-only symbols (`import type { X }` or inline
  `type X`). Keep `any` out of new code except at the hook boundaries where
  the DOM genuinely gives you `any`.
- Prefer `Reflect.apply`, `Reflect.construct`, `Reflect.defineProperty`,
  `Reflect.getOwnPropertyDescriptor` over the `Object.*`/`Function.prototype`
  forms in inject code; the inject bundle snapshots `Reflect`, so those stay
  safe after the page has tampered with its globals.
- No `eval`, `new Function` or string timers outside `rewriteJS`/`Access`.
- Optional chaining and nullish coalescing are fine; remember the rewriter
  has to preserve their short-circuiting when it rewrites them.

**Naming**

- `camelCase` for variables, functions and files that export functions;
  `PascalCase` for classes and files that export a class (`Client.ts`,
  `RemoteTransport.ts`); `UPPER_SNAKE` for module-level constants.
- Hook modules are `XModule` classes in `src/inject/.../modules/X.ts`.
- Message and RPC keys are `$stomp$...` strings exported from one place
  (`src/transport/messages.ts`); never inline them.

**Comments and prose**

- A comment says _why_ a hook or special case exists (which page behaviour it
  defends against), not what the code does.
- No em dashes anywhere: not in code comments, not in docs, not in the
  changelog, not in commit messages. Use a comma, a colon, parentheses, or a
  new sentence.
- Keep comments and docs in plain ASCII punctuation; no smart quotes.
- Update `CHANGELOG.md` for user-visible changes and `demo/README.md` when the
  demo's API usage changes.
