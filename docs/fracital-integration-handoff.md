# Fracital and stomp-rewrite: integration handoff

Work list for stomp-rewrite so Fracital can embed stomp as a second proxy
engine beside Scramjet. Fracital-side wiring (engine adapter, lazy boot,
the settings row) is tracked in the Fracital repo, not here.

## Status (kept current)

| Workstream                           | State                                                                                                                                                                                                                                                            | Where                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| WS1 request-header policy            | done: `rules` / `setRules` on both controllers (URLPattern match, header set and delete, block, redirect, status), applied after stomp rebuilds Origin and Referer so a host rule wins, `onRequest` reports `rule`; acceptance checks in `test/suites/rules.mjs` | shipped                           |
| WS2 epoxy as the supported transport | in progress: `examples/minimal-host.html` boots a same-origin `StompController` on epoxy; README "Embedding"                                                                                                                                                     | host example agent                |
| WS3 relocatable asset paths          | queued behind WS1: `assets` option naming every served file, inventory of literals in docs                                                                                                                                                                       | parity session                    |
| WS4 same-origin hook coverage        | in progress: scramjet's adversarial corpus ported as measurement suites; leaks become parity rows and fixes                                                                                                                                                      | corpus agent, then parity session |
| WS5 host-embedding API parity        | in progress: `test/suites/host-api.mjs` runs the checklist against the example host                                                                                                                                                                              | host example agent                |

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

## Config stomp will receive from Fracital (reference)

- `codec`: `aes` (or `xor`) for routed-URL encoding
- `directory`: a renamed neutral path (WS3)
- `transport`: `new EpoxyTransport({ wisp })`, same-origin
- `cache`: default on
- `onNavigate` / `onRequest` / `onOpen`: wired to the host tab store
- `requestHeaders`: WS1 rules, to present the host's first-party origin on
  configured hosts
