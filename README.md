# stomp-rewrite

A rewrite of the Stomp proxy.

Original implementation of https://github.com/tomphttp/implementations.

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

| Member                      | Description                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `new StompController(init)` | `init.serviceworker`, `init.transport`, optional `codec`, `directory` |
| `wait()`                    | resolves when the service worker has a server for this controller     |
| `createFrame(iframe?)`      | returns a `Frame`; creates an `<iframe>` when none is given           |
| `setTransport(transport)`   | hot-swap the transport                                                |
| `route(url)`                | the proxied URL for `url`, if you need it without a `Frame`           |
| `transport`, `frames`       | current transport and the frames created so far                       |

`Frame`:

| Member                 | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `go(url)`              | navigate the frame to `url` through the proxy       |
| `back()` / `forward()` | history navigation inside the frame                 |
| `reload()`             | reload the proxied page                             |
| `url`                  | the real URL of the page the frame shows, or `null` |
| `element`              | the underlying `<iframe>`                           |

`SearchBuilder(template)` turns free text into a URL: hosts and URLs pass
through, everything else is substituted into `template` at `%s`.

`RemoteController` (also `window.StompRemoteController` from
`dist/Controller.js`) is the host-side controller for origin isolation; it has
the same shape as `StompController` but runs the real controller in a hidden
frame on the proxy origin:

| Member                        | Description                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `new RemoteController(init)`  | `init.proxyOrigin`, `init.transport` (`{ module, options }`), optional `directory`, `codec`, `sandbox`, `pollInterval` |
| `wait()`                      | resolves once the controller frame has registered the service worker and loaded the transport                          |
| `createFrame(iframe?)`        | returns a `RemoteFrame`; applies the sandbox attribute                                                                 |
| `setTransport(descriptor)`    | hot-swap the transport (loaded inside the controller frame)                                                            |
| `route(url)`                  | the proxied URL for `url` on the proxy origin                                                                          |
| `frames`, `config`, `element` | frames created so far, the controller's config, the hidden controller iframe                                           |

`RemoteFrame`: `go(url)`, `back()`, `forward()`, `reload()` (the last three
are relayed through the controller frame, which is same-origin with the
proxied page), `url` and `title` (last known, refreshed every
`pollInterval` ms), `element`.

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
