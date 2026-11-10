# Emulated service workers

Proxied pages get a working `navigator.serviceWorker` unless the controller
is built with `serviceWorkers: false`. A page's service worker never becomes a
real registration: every proxied site shares the proxy's one real origin, and
a real worker registered there by page code could answer the proxy's own
requests, its bundles and other sites' pages, which is an escape (the reason
`navigator.serviceWorker` was absent until now, docs/scramjet-parity.md
section 10 item 1). Instead the page's worker script runs in a dedicated
Worker that the controller starts, with the worker inject and a global that
reads as a `ServiceWorkerGlobalScope`, and Stomp's own service worker hands it
the requests it would have received.

The flag is on by default. With it off nothing below runs, and pages see
`navigator.serviceWorker` absent, which a page can read as a proxy tell:
every Chrome page in a secure context has it.

## Pieces

| Piece                  | Where                                              | What it does                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry and lifecycle | `src/server/serviceWorkers.ts` (real SW)           | registrations per real scope URL in IndexedDB (`stompServiceWorkers`), the stored script and imported scripts of each version, which client each registration controls; the job queue (register, update, unregister), install and activate, update checks with byte compare |
| Fetch interception     | `genericForward` in `src/server/rewrites.ts`       | after the host's request rules and before the HTTP cache, a request whose client (or, for a navigation or a worker script, whose URL) belongs to an active registration is dispatched as a FetchEvent; the answer replaces the upstream response and is rewritten as usual  |
| Worker host            | `StompController` (`src/controller/index.ts`)      | starts a dedicated `Worker` at the version's `sw:` route on the real worker's request and hands back a MessagePort; terminates it on request or on a new handshake                                                                                                          |
| Worker global          | `src/inject/worker/modules/ServiceWorkerGlobal.ts` | `registration`, `serviceWorker`, `clients`, `skipWaiting`, the event handler attributes, `ExtendableEvent`, `InstallEvent`, `FetchEvent`, `ExtendableMessageEvent`, `Client`, `WindowClient`, `Clients`; removes what a dedicated worker has and a service worker does not  |
| Page API               | `src/inject/dom/modules/ServiceWorker.ts`          | `navigator.serviceWorker` and the `ServiceWorkerContainer`, `ServiceWorkerRegistration`, `ServiceWorker` and `NavigationPreloadManager` objects over the native prototypes                                                                                                  |

## Where the emulated worker lives, and why

Three hosts were possible: a dedicated Worker of the page that registered, a
SharedWorker named for the site, or a dedicated Worker of the controller.

- A worker of the page dies with the page, so a navigation (the case that
  matters most: the worker serving the next document, offline) would have to
  start it again in a document that does not exist yet.
- A SharedWorker survives only while some document of the site keeps it, and
  Chrome terminates it as soon as the last one goes, which is exactly the
  moment of a navigation in a single tab. Every proxied site also shares the
  real origin, so the worker would be reachable by name from any page that
  gets hold of a pristine constructor.
- The controller lives as long as the tab (the host page in same-origin mode,
  the controller frame in isolated mode, both on the proxy origin and both
  already talking to the real service worker). A Worker it starts is reachable
  only through the Worker object the controller keeps, never from page code,
  and it outlives every navigation of the proxied frames.

So the controller hosts the workers. It does not relay the events: when it
starts a worker it gives the real service worker one end of a MessageChannel
and the worker the other, and every event and every call of the worker goes
over that port directly, off the host page's main thread (which a proxied
page in same-origin mode shares).

A version runs in one instance at a time, in whichever live controller
started it (the one whose page needed it first). When that controller goes
(its tab closes or the real worker forgets it), the instance is dropped and
the next event starts a new one in a live controller. An instance with no
event in flight for 30 s is stopped, as a browser stops an idle worker; the
next event starts it again (state lives in caches and IndexedDB, as a site's
worker must expect natively).

## Request flow

```
page (proxied site S, client C)              Stomp's service worker                      controller (host page / controller frame)
------------------------------              ----------------------                      ------------------------------------------
fetch('/api') or <img>, or a navigation
  --> routed request /stomp/<id>/<kind>/...
                                             fetch event -> router -> genericForward
                                               host rules (block / answer / redirect)
                                               intercept?
                                                 subresource: registration that controls C
                                                 navigation / worker script: longest scope
                                                   of S that prefixes the real URL,
                                                   C becomes controlled by it
                                               no registration --> HTTP cache, transport
                                               registration, worker not running:
                                                 rpc startServiceWorker -------------------> new Worker(/stomp/<id>/sw:<version>/<url>)
                                                                                              worker inject + SW global, page script
                                                 <------------------------------------------- MessagePort (worker <-> real SW)
                                               dispatch fetch over the port  ---------------> emulated worker: FetchEvent on self
                                                                                                respondWith(p) / nothing
                                               <------------------------------------------------ "responded" or "fallback" (5 s)
                                               <------------------------------------------------ the Response (30 s): status,
                                                                                                headers, body as a body port
                                               fallback, timeout or dead port --> HTTP cache, transport (network)
                                               response --> header filter, body rewrite
                                                 (HTML shell with the inject, JS, CSS)
  <-- response
```

The worker's own requests (`fetch`, `importScripts`, `cache.add`) come back
to Stomp's service worker from the worker's client, which is recognised by
its `sw:` route and never intercepted, so they go to the network as a
service worker's own fetches do.

A navigation the emulated worker answers is still an HTML document of the
`html` route: the worker's body is what the origin would have sent, and the
real worker wraps it in the shell, so the page gets the inject even when it
comes out of the site's cache while the site is unreachable. The shell also
carries the registration that controls the new document, so
`navigator.serviceWorker.controller` is set before the page's first script,
as natively.

Navigation preload: when the registration has it on, a GET navigation's
request goes out from Stomp's service worker as soon as the navigation is
routed, in parallel with the worker's start, as the navigation itself (its
destination, mode and cookies) plus `Service-Worker-Navigation-Preload` with
the registration's header value; its `Set-Cookie` fields are applied as its
headers arrive. The FetchEvent's `preloadResponse` resolves to a `basic`
Response of the real URL whose body crosses to the worker only when
something reads it. A worker that passes that Response to `respondWith`
unread (YouTube's does for every navigation outside its app shell) hands
the page the network's answer as it is, rewritten like any network
response, without the body going to the worker and back; one that reads it
answers with its own copy; one that answers nothing leaves it unused and the
navigation goes to the network again, as Chrome 152 does
(service-worker-preload suite).

Page API calls (`register`, `getRegistration`, `update`, `unregister`,
`postMessage`, the navigation preload manager) are messages to the real worker
with a reply port, handled under `event.waitUntil` so the real worker stays
alive through an install. State changes go back to every document of the site
as messages, which the page module turns into `statechange`, `updatefound`
and `controllerchange` events in the order the spec gives.

## Lifecycle

The job queue is per scope. `register` resolves the script and scope against
the document (scheme, origin and `%2f` checks happen in the page with the
browser's messages), then in the real worker:

1. An existing registration with the same script URL and `updateViaCache`
   answers at once (no update), as the spec's Register does.
2. Update: the script is fetched through the proxy with `Service-Worker:
script`, past the HTTP cache unless `updateViaCache` is `all`; a redirect,
   a non-2xx status, a non-JavaScript MIME type, or a scope outside the
   maximum (the script's directory, or `Service-Worker-Allowed`) rejects with
   the browser's error. Identical bytes to the newest version end the job.
3. A new version (state `parsed`) is started; a script that throws at top
   level rejects with `ServiceWorker script evaluation failed`.
4. Install: `installing` is set, the worker goes `installing`, `register`
   resolves, `updatefound` fires, then the `install` event runs with its
   `waitUntil` promises. A rejection makes the version `redundant` (and a
   registration with no other version is removed); otherwise it moves to
   `waiting`, state `installed`.
5. Activate, when the waiting version called `skipWaiting()` or the active
   version controls no live client: the old active goes `redundant`, the
   waiting one becomes `active` in state `activating`, the clients the
   registration controls get it as their controller (`controllerchange`),
   the `activate` event runs, then `activated`. A waiting version is retried
   whenever a navigation, an API call or an event reaches the real worker.

`clients.claim()` makes every client of the site within scope controlled by
the registration (`controllerchange` in each). A navigation (or a worker
script) within the scope of a registration with an active version makes the
new document controlled and schedules an update check (one at a time per
registration). `update()` runs the same check; `unregister()` removes the
registration once its clients are gone, as the spec's "uninstalling" flag
does, and at once when none are controlled.

Registrations, versions, scripts and imported scripts persist in IndexedDB,
so a reload or a new tab finds them, and an installed version starts again
without the network (its main script and the scripts it imported during
install are served from storage, the way a browser keeps a worker's script
resources).

## Isolation

A proxied site's emulated worker sees only its own site's requests:

- The site of a request's client, and of an API call's sender, is decided by
  the real worker from the client's routed URL (decoded with its controller's
  codec), never from anything the page sends.
- A registration's scope and script URL must be of the sender's origin.
  Matching is the spec's: the longest scope URL that is a string prefix of
  the request URL (navigations, worker scripts) or the client URL (claim),
  across registrations of that origin only.
- A subresource request is dispatched only to the registration recorded as
  controlling its client, which was recorded only for a navigation of that
  origin inside the scope, or by `claim()` for clients of that origin. A
  document of another site never has that record.
- `clients.matchAll()` and `clients.get()` answer with clients of the
  worker's origin only, and `Client.postMessage` refuses a client of another
  origin. State messages go to documents of the site (and to `about:srcdoc`
  and `about:blank` documents, whose URL names no site; their inject drops a
  message for another origin).
- The worker's `caches` are the site's (cache names carry the origin, and
  `caches.match()` looks in the site's caches only, never in another site's
  or Stomp's own HTTP cache); its IndexedDB is the site's as any worker's.
- The `sw:` and `swimport:` routes answer the controller's Worker and the
  emulated worker itself only; a proxied page that asks gets a 403.
- Nothing real is registered: the page's `navigator.serviceWorker` is the
  emulated container, and the native container's `register`,
  `getRegistration` and `getRegistrations` reject for every object the page
  could reach.

The window membrane is unaffected: no window crosses into the worker
(`WindowClient` is a description, not a window), and the membrane's per-site
comparison stays the page module's concern. Registrations are keyed by
origin, which is stricter than the membrane's site key.

## API surface and choices

- `navigator.serviceWorker`: `register`, `getRegistration`,
  `getRegistrations`, `ready`, `controller`, `oncontrollerchange`,
  `onmessage`, `onmessageerror`, `startMessages()`; messages are queued until
  `startMessages()`, an `onmessage` assignment or the end of parsing.
- `ServiceWorkerRegistration`: `installing`, `waiting`, `active`, `scope`,
  `updateViaCache`, `update()`, `unregister()`, `onupdatefound`,
  `navigationPreload` (its state kept per registration, and the preload
  request sent as described under Request flow).
- `ServiceWorker`: `scriptURL` (the real URL), `state`, `postMessage`,
  `onstatechange`, `onerror`.
- The registration's managers are all there and behave as Chrome's do
  (measured in Chrome 152, page and worker), every API simulated rather
  than left out:
  - `sync.register()` runs: the tag is kept with the registration, the
    worker gets a `SyncEvent` (once more after 5 and then 15 minutes, the
    last with `lastChance`, when its `waitUntil` rejects), and `getTags()`
    lists what has not run to success.
  - `periodicSync.register()` rejects `NotAllowedError: Permission
denied.`, as Chrome does without the site engagement it asks for.
  - `backgroundFetch.fetch()` downloads through the proxy (as the page,
    with its cookies), then the worker gets `backgroundfetchsuccess` or
    `backgroundfetchfail` (`backgroundfetchabort` after `abort()`) with a
    `BackgroundFetchRegistration` whose `matchAll()` gives the records; in
    the worker `fetch()` rejects as natively. The fetches live as long as
    Stomp's service worker runs, and no `progress` event fires.
  - `paymentManager` keeps `userHint` and `enableDelegations()` answers
    `true`; the payment events exist and never fire.
  - `cookies` keeps the cookie change subscriptions (`subscribe`,
    `getSubscriptions`, `unsubscribe`, URLs within the scope), and the
    worker gets an `ExtendableCookieChangeEvent` (`cookiechange`) for each
    change of a cookie a subscription covers, whoever made it (a page's
    `document.cookie` or `cookieStore`, a response's `Set-Cookie`, the
    worker itself): Stomp's service worker compares what each subscription
    URL shows in the jar with what it showed. Changes while Stomp's worker
    was stopped are not reported; its comparison starts again from the jar.
- The worker's `cookieStore` is the page's over the same jar (the methods,
  dictionaries and errors are shared, `cookieStoreMethods`), with a
  service worker's rule for `url`: Chrome 152 takes only the worker's own
  script URL (query and fragment aside, relative ones resolved against
  it) and refuses even its scope with "URL must be within Service Worker
  scope". It has no `onchange`, as natively (service-worker-cookies
  suite, against a real worker).
  - Push answers as Chrome without the notification permission:
    `permissionState()` is `prompt` in a page and `denied` in the worker,
    `subscribe()` rejects `AbortError: Registration failed - permission
denied`, `getSubscription()` resolves `null`. `showNotification()`
    rejects as without the permission and `getNotifications()` resolves
    `[]`: the proxy origin's one notification permission would be every
    site's.
- An opaque document (sandboxed without `allow-same-origin`) throws the
  browser's `SecurityError` when it reads `navigator.serviceWorker`.
- The container and the objects behind it (a few hundred hooked members of
  the service worker interfaces and their managers) are made on the
  document's first read of `navigator.serviceWorker`, or at once in a
  document a worker controls or when a worker of its site messages it. A
  frame that never reads it (an ad or cookie-sync frame) costs no more
  memory than with the flag off (measure-frame-memory: 1,220 KB of heap
  per frame either way, 1,276 KB when they were made in every frame).

## Timeouts

A worker that does not start in 10 s, does not say within 5 s whether
`respondWith` was called, or whose `respondWith` promise does not settle in
30 s, is treated as absent for that request: the request goes to the network.
A dead port (the hosting controller went) is noticed by the same timers. The
page never waits on a worker longer than that.

## Status and tests

Landed in four stages, each measured against the same pages loaded
natively in both demo modes (the suites still ask for the flag with `?sw`;
`?sw=<ms>` also sets `serviceWorkerTimeout`):

| Stage                                 | Suites                                                |
| ------------------------------------- | ----------------------------------------------------- |
| API surface and lifecycle             | `service-workers`, `service-worker-updates`           |
| Fetch interception for subresources   | `service-worker-fetch` (with the timeout fallbacks)   |
| Navigations and offline               | `service-worker-offline`, `service-worker-updates`    |
| Cache API scoping, clients, messaging | `service-worker-messages`, `service-worker-isolation` |
| Navigation preload                    | `service-worker-preload`                              |

`test/sw-site.mjs` is a site of the suites' own on a free port, so a suite
can change a worker script's bytes and take the site offline. Real sites
checked headless (2026-11-10), natively and with `?sw`: squoosh.app,
excalidraw.com, developer.chrome.com (Workbox) and app.diagrams.net
register, activate and (after a reload) are controlled exactly as natively,
with element counts within 3% and no page errors; web.dev's worker runs on
the appspot document the proxy lands on with or without the flag; x.com
(logged out) and vite.dev register none, natively too.

The flag is on by default since a sweep of 19 pages (2026-11-10, Chrome
152 with a regular Chrome user agent and scrollbars, each loaded natively,
through the demo with the flag on and with it off, then reloaded in place):
YouTube's home and a /watch page, Google, Gmail and Google sign-in, x.com,
Discord, Spotify, Reddit (a bot wall natively too), GitHub, MDN, web.dev,
squoosh.app, Excalidraw, whatpwacando.today, Facebook, Wikipedia,
developer.chrome.com and diagrams.net. The eight sites that register a
worker register, activate and, where they are natively, are controlled
after the reload (YouTube, web.dev, squoosh.app, Excalidraw,
developer.chrome.com); element counts are within 4% of native either way;
no page error comes with the flag on, while with it off squoosh.app and
whatpwacando.today throw on the missing `navigator.serviceWorker`. Load
times are the proxy's with or without the flag (YouTube /watch reloads, 8
each, worker-controlled against flag off: 3,551 and 3,523 ms median); a
site without a worker loads as fast (a fixture of 60 scripts, 60 images
and 40 fetches: 416 ms to its load event with the flag on, 460 ms off), and
a frame that never reads `navigator.serviceWorker` costs the same memory.
Hosts should leave it on.

## Limitations

- `event.isTrusted` is `false` for the emulated events (it cannot be set).
- A member of `ServiceWorkerContainer.prototype`,
  `ServiceWorkerRegistration.prototype` or a manager's prototype that a
  page takes before its first read of `navigator.serviceWorker` is the
  native one: it is another function than the one read after, and called on
  an emulated object it throws `Illegal invocation`.
- The worker is a dedicated Worker underneath, made to read as a
  service worker: its global's own names are a Chrome service worker's
  (the dedicated-only APIs, `URL.createObjectURL` and `postMessage` gone,
  the push, sync, background fetch, payment and cookie interfaces and
  their handlers there), each interface's prototype is read-only and an
  event constructor called without `new` throws the browser's error
  (service-worker-global suite). A determined script can still find its
  real prototype chain.
- Responses the worker passes through keep the shape the proxy gives them: a
  `no-cors` request across origins is readable in the worker (the proxy
  makes every request same-origin to the browser), not opaque. A truly
  opaque or opaque-redirect response sends the request to the network.
- A request the worker re-fetches (`fetch(event.request)`) goes out as a
  same-origin `fetch` with Sec-Fetch-Dest `empty`, not as the navigation.
- `about:srcdoc` and `about:blank` documents, blob: workers and data:
  documents are never controlled (their URL names no site the real worker
  can verify).
- Registrations are keyed by origin, not by top-level site: a site framed by
  another shares its registrations with its top-level visits.
- Module service workers' static imports are not kept for offline starts
  (classic `importScripts` are).
- One instance per version across tabs while a controller hosts it; with no
  shared host the instances of two tabs can be two.
- Only the main script is byte-compared on update, not its imported scripts.
- `WindowClient.focused` of a proxied page follows the host page's focus
  (the browser sees an iframe), not the frame's own.
- An instance's in-memory state goes when it idles for 30 s or the browser
  restarts Stomp's service worker, as a real worker's may at any time.
