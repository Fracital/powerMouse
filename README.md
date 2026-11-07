# stomp-rewrite

A rewrite of the Stomp proxy.

Original implementation of https://github.com/tomphttp/specifications.

Stomp rewrites HTML, CSS and JavaScript inside a service worker and tunnels the
actual HTTP and WebSocket traffic through a
[proxy-transports](https://github.com/MercuryWorkshop/proxy-transports)
transport (for example [epoxy](https://github.com/MercuryWorkshop/EpoxyTransport)
or [libcurl](https://github.com/MercuryWorkshop/CurlTransport)) that lives in
the page that owns the proxy. Proxied content is shown in frames.

## Usage

Serve `dist/` (its path is exported from `stomp-rewrite/path` as `stompPath`)
from a directory of your site, register the service worker with that directory
as its scope, and hand it to a controller together with a transport:

```js
import EpoxyTransport from '@mercuryworkshop/epoxy-transport';
import { StompController } from 'stomp-rewrite';

const registration = await navigator.serviceWorker.register(
	'/stomp/serviceWorker.js',
	{ scope: '/stomp/' },
);

const controller = new StompController({
	serviceworker: registration.active,
	transport: new EpoxyTransport({ wisp: 'wss://example.com/wisp/' }),
	directory: '/stomp/',
	codec: 'xor',
});

await controller.wait();

const frame = controller.createFrame(document.querySelector('iframe'));
await frame.go('https://example.com');
```

`dist/Controller.js` and `dist/SearchBuilder.js` expose the same API as classic
scripts through the `StompController` and `SearchBuilder` globals.

Any `ProxyTransport` works. In testing against a `wisp-js` server, epoxy was
the better choice for HTTP-heavy sites and libcurl for WebSockets; see the
changelog's known limitations before picking one.

## API

`StompController` (also `window.StompController` from `dist/Controller.js`):

| Member                                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new StompController(init)`                                                        | `init.serviceworker`, `init.transport`, optional `codec`, `directory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `init.allowInvalidJs`                                                              | a script the rewriter cannot parse runs as it was (default); `false` makes it fail with a `SyntaxError` naming the rewriter error, so a broken rewrite is loud                                                                                                                                                                                                                                                                                                                                                                                |
| `init.assets`                                                                      | optional names of the served files (`serviceWorker`, `injectDocument`, `injectWorker`, `controllerFrame`, `controllerFrameScript`), default the dist names; a host that vendors the bundle under neutral names tells stomp what it called them, and no requested URL then carries the package name                                                                                                                                                                                                                                            |
| `init.rules`                                                                       | optional `RequestRule[]`: declarative request rules applied in the service worker to the real URL, first match wins: `match` (URLPattern `url`, `method`, `destination`, `site`), `action` `'block'` or `{ requestHeaders, responseHeaders, redirect, status }` (`null` deletes a header); applied after stomp rebuilds Origin, Referer and cookies, so a host rule wins. URLPattern is Chrome-only; a missing constructor or an invalid pattern skips that rule with one console warning                                                     |
| `init.cache`                                                                       | `cache` (default `true`): HTTP cache in the service worker, explicit freshness only, revalidated when stale; `false` turns it off                                                                                                                                                                                                                                                                                                                                                                                                             |
| `init.onRequest`                                                                   | optional `onRequest(info)`: one report per proxied request: real `url` (a CSS image without the rewriter's `#url(...)` fragment), `method`, `destination` (`fetch` for fetch, XHR and keepalive beacons), `status` (0 with `error` on a transport failure), `ms`, `cached`, `bytes`, and `frame`: the document's own report and head subresources wait up to 1.5 s for the page's client id, so they carry their frame too; also dispatched as a `request` CustomEvent on the controller (`detail` is the report); nothing is sent when unset |
| `init.onNavigate`                                                                  | optional `onNavigate(info, frame)`: the page reported where it is (`{ url, title, canGoBack, canGoForward }`); also dispatched as a `navigate` CustomEvent on the frame and on the controller (`detail: { info, frame }`)                                                                                                                                                                                                                                                                                                                     |
| `init.onOpen`                                                                      | optional `onOpen(url, frame)`: called when a page wants a new tab (`window.open`, a link with `target="_blank"` or a name, a modifier or middle click); the page's `window.open` then returns `null`, like a popup blocker; also dispatched as an `open` CustomEvent on the controller (`detail: { url, frame }`). Without it popups open natively as bare proxied tabs                                                                                                                                                                       |
| `wait()`                                                                           | resolves when the service worker has a server for this controller; a build mismatch is healed first (update, wait for activation, rebind) and otherwise resolves on the worker at hand with `stale` set                                                                                                                                                                                                                                                                                                                                       |
| `stale`, `stale` / `rebind` events                                                 | `{ controller, worker }` builds while an older worker is still in charge; the controller rebinds on its own when the new one activates and dispatches `rebind` (`{ build }`)                                                                                                                                                                                                                                                                                                                                                                  |
| `createFrame(iframe?)`                                                             | returns a `Frame`; creates an `<iframe>` when none is given                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `setTransport(transport)`                                                          | hot-swap the transport                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rebind(worker?)`                                                                  | talk to another service worker (default: the registration's active one) and shake hands again; a build mismatch does this on its own before `wait()` would reject                                                                                                                                                                                                                                                                                                                                                                             |
| `clearCache()`                                                                     | drop the HTTP cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `setRules(rules)`                                                                  | replace the request rules at run time; `onRequest` reports the index of the rule applied as `info.rule`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cookies.get(url)` / `.set(url, setCookie)` / `.list(origin?)` / `.clear(origin?)` | the jar as the host sees it (host-only: pages never reach this port)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `route(url)`                                                                       | the proxied URL for `url`, if you need it without a `Frame`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `transport`, `frames`                                                              | current transport and the frames created so far                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`Frame`:

| Member                                    | Description                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go(url)`                                 | navigate the frame to `url` through the proxy; resolves when the new document has reported (URL, title, history state in), a second after the frame's `load` event for a document that never reports, 30 s at the most. The first report comes at document start, so wait for the frame's `load` event (listened for before `go()`) before reading the page's DOM |
| `back()` / `forward()`                    | step the frame's own history; resolves to `false` when there is no entry in that direction (never walks the host page's history)                                                                                                                                                                                                                                  |
| `canGoBack` / `canGoForward`              | whether the frame's own history has an entry in that direction; `null` when the browser has no Navigation API                                                                                                                                                                                                                                                     |
| `reload()`                                | reload the proxied page; resolves like `go()`, `false` when there was nothing to reload                                                                                                                                                                                                                                                                           |
| `url`                                     | the real URL of the page the frame shows, or `null`                                                                                                                                                                                                                                                                                                               |
| `navigate` event, `title`, `lastNavigate` | the page's own reports (load, pushState, hashchange, title changes); no polling needed                                                                                                                                                                                                                                                                            |
| `element`                                 | the underlying `<iframe>`                                                                                                                                                                                                                                                                                                                                         |

`SearchBuilder(template)` turns free text into a URL: hosts and URLs pass
through, everything else is substituted into `template` at `%s`.

`RemoteController` (also `window.StompRemoteController` from
`dist/Controller.js`) is the host-side controller for origin isolation; it has
the same shape as `StompController` but runs the real controller in a hidden
frame on the proxy origin:

| Member                             | Description                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new RemoteController(init)`       | `init.proxyOrigin`, `init.transport` (`{ module, options }`), optional `directory`, `codec`, `sandbox`, `pollInterval`                                              |
| `init.allowInvalidJs`              | as on `StompController`                                                                                                                                             |
| `init.assets`                      | as on `StompController`; the controller frame is loaded as `<directory><controllerFrame>?script=<controllerFrameScript>` and learns its script name from that query |
| `init.rules`                       | as on `StompController`, relayed through the controller frame                                                                                                       |
| `init.cache`                       | as on `StompController`                                                                                                                                             |
| `init.onRequest`                   | as on `StompController`, relayed through the controller frame                                                                                                       |
| `init.onNavigate`                  | as on `StompController`; the reports arrive from the proxy origin and are accepted only from this controller's own frames                                           |
| `init.onOpen`                      | as on `StompController`: the request reaches the host from the proxy origin and is accepted only from this controller's own frames                                  |
| `wait()`                           | resolves once the controller frame has registered the service worker and loaded the transport                                                                       |
| `createFrame(iframe?)`             | returns a `RemoteFrame`; applies the sandbox attribute                                                                                                              |
| `setTransport(descriptor)`         | hot-swap the transport (loaded inside the controller frame)                                                                                                         |
| `clearCache()`                     | drop the HTTP cache (inside the controller frame)                                                                                                                   |
| `setRules(rules)`                  | as on `StompController`                                                                                                                                             |
| `cookies.*`                        | as on `StompController`, relayed through the controller frame                                                                                                       |
| `route(url)`                       | the proxied URL for `url` on the proxy origin                                                                                                                       |
| `frames`, `config`, `element`      | frames created so far, the controller's config, the hidden controller iframe                                                                                        |
| `stale`, `stale` / `rebind` events | as on `StompController`, mirrored from the controller frame                                                                                                         |

`RemoteFrame`: `go(url)`, `back()`, `forward()`, `reload()` (the last three
are relayed through the controller frame, which is same-origin with the
proxied page), `url`, `title`, `canGoBack` and `canGoForward` (last known,
refreshed every `pollInterval` ms), `element`.

A transport descriptor is `{ module: '/epoxy/index.mjs', options: [{ wisp }] }`:
the module URL must be on the proxy origin and its default export is the
transport class, constructed with `...options`.

## Origin isolation

`StompController` keeps everything on one origin, so a proxied page is
same-origin with the page that embeds it. Browsers grant same-origin frames
full access to each other: `parent.document`, `top.location = ...`,
`frameElement`, cookies and storage of the host. Stomp's hooks hide most of
that from the page's own (rewritten) JavaScript, but hooks are not a security
boundary. **Same-origin mode is for development only.**

Origin isolation serves `dist/` and all proxied content from a second origin
(for example `app.example.com` hosting the UI and `proxy.example.com` serving
the proxy). The host page creates a `RemoteController`, which embeds
`dist/controllerFrame.html` from the proxy origin; that frame registers the
service worker, loads the transport and runs the real `StompController`.
Proxied pages live in sandboxed, cross-origin iframes (`allow-same-origin`
so the service worker controls them, no `allow-top-navigation`), so the
browser itself refuses them any access to the host, and the service worker
sends `Content-Security-Policy: frame-ancestors <host origin>` so nothing
else can embed the proxy origin. On top of that the inject bundle makes the
page believe it is top-level: `top`, `parent`, `frameElement`, `window.name`,
`outerWidth`/`outerHeight`, `screenX`/`screenY`, `document.referrer` and
`location.ancestorOrigins` all answer as they would for a real top window,
and `message` events from outside the proxied world never reach the page.

## Embedding

[`examples/minimal-host.html`](examples/minimal-host.html) is the smallest
host application: plain HTML and one module script, with a comment per step.
The demo server serves it at `/examples/minimal-host.html`
(`npm run demo`), and `test/suites/host-api.mjs` runs the host API checklist
against it. The deployment settings sit in one object at the top of the
script (`directory`, the transport module, the wisp URL, `codec`).

The boot sequence it shows: register `serviceWorker.js` from the directory
`dist/` is served from, with that directory as the scope and
`updateViaCache: 'none'`, and wait for the worker to be activated; import the
transport module and construct it with the wisp URL; create the
`StompController` with the service worker, the transport, the directory, the
codec and the callbacks; `await controller.wait()`; then `createFrame()` and
place its `<iframe>`. From there `frame.go(url)`, `back()`, `forward()` and
`reload()` drive the frame, and `canGoBack` / `canGoForward` tell the host
what to enable. `controller.stale` and the `stale` / `rebind` events say
whether an older service worker is still in charge after a deploy.

The three callbacks are the host's view of the pages: `onNavigate` reports
URL, title and history state whenever the page changes them (the example
updates its address input and title from it), `onOpen` receives the URL a
page wanted in a new tab (the page's `window.open` returns `null`; the
example opens it in place, a real host opens a tab), and `onRequest` reports
every proxied request with its real URL, status and the `Frame` it belongs
to (the example appends one line per request to a log).

The example runs the same-origin `StompController`, which is not a security
boundary; a deployment that must keep proxied pages away from the host uses
`RemoteController` on a second origin, see "Origin isolation" above.

Transport: use epoxy for HTTP-heavy sites. Pages that rely on WebSockets are
the exception (incoming frames stop after the first round trip against
wisp-js 0.5, see the changelog's known limitations and the transports note
in `AGENTS.md`); the demo's transport selector switches to libcurl for
those, which in turn stops answering HTTP after some tens of requests.

## Demo

`npm run demo` serves a complete host application on http://localhost:8080,
including a wisp server and both transports. It is documented in
[`demo/README.md`](demo/README.md) and is the quickest way to see the API above
in use. It is live at https://stomp.fracit.al, deployed from `master` by
`.github/workflows/deploy.yml`.

## Development

```sh
npm install
npm run build   # type-check, bundle with esbuild, emit declarations
npm run dev     # rebuild on change
npm run demo    # http://localhost:8080 with a wisp server, epoxy and libcurl
npm run lint
```
