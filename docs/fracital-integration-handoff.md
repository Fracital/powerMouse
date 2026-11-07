# Fracital and stomp-rewrite: integration handoff

Work list for stomp-rewrite so Fracital can embed stomp as a second proxy
engine beside Scramjet. Fracital-side wiring (engine adapter, lazy boot,
the settings row) is tracked in the Fracital repo, not here.

## Status (kept current)

| Workstream                           | State                                                                                                                                                                                                                                                                                                                                                                  | Where                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| WS1 request-header policy            | done: `rules` / `setRules` on both controllers (URLPattern match, header set and delete, block, redirect, status), applied after stomp rebuilds Origin and Referer so a host rule wins, `onRequest` reports `rule`; acceptance checks in `test/suites/rules.mjs`                                                                                                       | shipped                       |
| WS2 epoxy as the supported transport | done: `examples/minimal-host.html` boots a same-origin `StompController` on epoxy and proxies Wikipedia; README "Embedding" carries the transport guidance                                                                                                                                                                                                             | shipped                       |
| WS3 relocatable asset paths          | done: `assets` on both controllers names every served file (defaults to today's names), the controller frame learns its script name from `?script=`; the assets suite boots a fully renamed bundle under `/neutral/` and sees no URL with the package name                                                                                                             | parity session                |
| WS4 same-origin hook coverage        | measured: scramjet's adversarial corpus runs as nine measurement suites (`test/suites/adversarial-*.mjs`); 22 failing checks left from 180, all documented in the parity doc's corpus row (eight probes reporting the browser's own result, MutationObserver records of the marker writes, blob: URLs on the proxy origin, `navigator.serviceWorker` absent by design) | shipped; still not a boundary |
| WS5 host-embedding API parity        | checklist green (`test/suites/host-api.mjs`, 41 checks against the example host); gap list shipped in full                                                                                                                                                                                                                                                             | shipped, gaps in progress     |

## Goal and shape

- Fracital adds stomp as a selectable engine, gated behind an "Enable
  experimental proxies" setting. Off by default; when on, stomp shows up as a
  pick in the existing engine selector. It is never in the selector while the
  setting is off.
- Transport: **epoxy** (Fracital's EpoxyTransport fork).
- Mode: **same-origin `StompController`**. In-house use; the proxied sites are
  ones the operator chooses to open.

## Decisions already made (do not reopen)

- **No second-origin / isolation requirement.** The browser-enforced
  `RemoteController` mode is out of scope for this integration. Same-origin is
  accepted.
- **Honesty rule for implementers.** Same-origin hooks are best-effort, not a
  security boundary; stomp already says this in `ControllerInit.sandbox` and
  the README. WS4 tightens coverage; it does **not** turn same-origin into
  isolation, and nothing in docs or API may claim it does. "Perfect" is not a
  reachable target on one origin; that is expected, state it plainly.

## WS1: host-configurable outbound request-header policy [new feature]

**Why.** Fracital needs proxied first-party service calls to carry the host
app's own `Origin`/`Referer`, chosen by the host, rather than the value stomp
derives from the proxied page. This is the standard reverse-proxy
"set header on upstream request" knob (cf. nginx `proxy_set_header`).

**Today.** stomp rebuilds `Origin`/`Referer` in the service worker from the
initiator (`src/server/rewrites.ts`, the Referer and Origin block) and deletes the browser's.
An internal `additionalRequestFilter` hook (`AdditionalFilter` in
`src/server/filterHeaders.ts`) exists but `createServer()` never passes one
(`src/server/createServer.ts` L62-69), so it is unreachable from the public
API.

**Build.**

1. Add `requestHeaders?` to `Config` (`src/config.ts`) and `ControllerInit`
   (`src/controller/index.ts`). Shape: a list of rules
   `{ match: hostGlob | predicate, set?: Record<string,string>, remove?: string[] }`.
2. Thread it through `ControllerInitMessage` (`src/transport/messages.ts`), then
   `createServer`, then `registerRewrites`, and apply in the outbound request path in
   `rewrites.ts`, **after** stomp's own `Origin`/`Referer` reconstruction so
   the host rule wins.
3. Scope by destination host: only configured targets are touched; every other
   request stays byte-identical to today.
4. Report what was applied through `onRequest` (`RequestInfo`) for debugging.

**Acceptance.** A rule that sets `Origin`/`Referer` for one configured host
shows on matching outbound requests; non-matching requests are unchanged;
no behavior change when `requestHeaders` is unset; works under epoxy and the
SW cache path.

## WS2: epoxy as the supported transport

- Confirm same-origin `StompController` runs with `new EpoxyTransport({ wisp })`
  passed straight to `ControllerInit.transport`.
- Keep the epoxy dependency aligned with Fracital's fork pin (package.json
  already points at the Fracital EpoxyTransport build (see `deploy/epoxy/README.md`)).
- Keep the README's "epoxy for HTTP-heavy" guidance current so the host can
  pick knowingly.

**Acceptance.** Demo plus a smoke page proxy an HTTP-heavy site over epoxy,
same-origin, with no regression against the current transport.

## WS3: relocatable, fingerprint-free asset paths [host vendoring]

**Why.** Fracital serves the bundle under renamed neutral paths; its build
rules forbid the package name in any served URL and rewrite path strings at
copy time (same treatment it gives Scramjet's controller).

**Today.** `directory` already relativizes asset URLs, but filenames are
hardcoded literals: `serviceWorker.js` (`src/controller/frame.ts` L102,
`src/controller/index.ts`), `controllerFrame.html` (`src/controller/remote.ts`
L99), and the inject bundle names.

**Build.**

1. Inventory every served filename and every cross-bundle reference
   (controllerFrame.html to controllerFrame.js, the service worker to the inject bundles, and so on).
2. Either make those filenames configurable, or guarantee each is a single
   unique literal the host can find-and-replace, and publish that list in docs.

**Acceptance.** The bundle boots when served from an arbitrary directory with
every filename renamed, and the string `stomp` appears in no requested URL.

**Shipped.** `assets` on `Config`, `ControllerInit` and `RemoteControllerInit`
(`serviceWorker`, `injectDocument`, `injectWorker`, `controllerFrame`,
`controllerFrameScript`). Inventory of what a host renames: the five files
above, plus `Controller.js` / `controller.mjs` which the host loads itself.
Not URLs, left as they are: the `$stomp$` postMessage keys and the `stomp`
RPC id (same-origin messages between the controller, the worker and the
pages), the `stomp-allowed-origins` meta in `controllerFrame.html`, the
IndexedDB name `stompCookies` and the Cache API store `stomp-http-cache`, the
default `directory` `/stomp/`. Checked by `test/suites/assets.mjs`.

## WS4: same-origin hook coverage (best-effort, not a boundary)

**Why.** In same-origin mode the hooks are the only thing constraining the
proxied page's rewritten code; Fracital wants that coverage as tight as
practical for the in-house threat model.

**Build.** Enumerate known host-reachability vectors from rewritten page code
(fresh iframe/worker clean globals, `new Function`/`import()`, prototype
walks, event targets), close the practical ones, add regression tests.

**Hard rule.** Hardening, not isolation. Do not represent same-origin mode as
a security boundary anywhere. This workstream cannot reach "perfect"; that is
expected and must be documented as such.

## WS5: host-embedding API parity (verification)

Confirm with tests the surface a host tab UI needs: `frame.url` / `title` /
the `navigate` event, back/forward/reload resolution, `onOpen` for new-tab
handling, `onRequest` for favicon/title, the cookies jar. Most of this exists;
treat as a checklist plus gap fixes, mirroring `docs/scramjet-parity.md`.

## WS5 gap list (from writing the example host)

All shipped (navigate-events, request-log and register suites); item 2 is
documented behaviour.

1. Shipped: `frame.go()` and `frame.reload()` resolve when the new document
   has reported (a second after the frame's `load` event for a document that
   never reports, 30 s at the most); `reload()` resolves `false` when there
   was nothing to reload.
2. Documented: the first `navigate` report fires at document start, before
   the body is parsed; right for an address bar, too early for anything
   reading the DOM. Listen for the frame's `load` event, attached before
   `go()`.
3. Shipped: head subresources fetched before the page has reported its client
   id wait up to 1.5 s for it and carry their frame like the document does.
4. Shipped: `onRequest` URLs for CSS `url()` images are reported without the
   `#url(...)` fragment the CSS rewriter appends.
5. Shipped: `destination` is `fetch` for keepalive POST beacons (the browser
   gives an empty string).
6. Shipped: both controllers dispatch `navigate`, `open` and `request`
   CustomEvents next to the constructor callbacks.
7. Shipped: `StompController.register(directory?)` registers the worker from
   the directory with that scope and resolves with the registration once it
   is activated (30 s cap, never hangs); the constructor's `serviceworker`
   accepts the registration. The example host lost its copied activation
   helper.
8. Shipped: both controllers and both frame classes keep their state in
   `#fields`; `lastHandshake` stays public for the dev loop.

## Config stomp will receive from Fracital (reference)

- `codec`: `aes` (or `xor`) for routed-URL encoding
- `directory`: a renamed neutral path (WS3)
- `transport`: `new EpoxyTransport({ wisp })`, same-origin
- `cache`: default on
- `onNavigate` / `onRequest` / `onOpen`: wired to the host tab store
- `requestHeaders`: WS1 rules, to present the host's first-party origin on
  configured hosts
