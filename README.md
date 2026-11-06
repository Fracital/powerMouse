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

## Demo

`npm run demo` serves a complete host application on http://localhost:8080,
including a wisp server and both transports. It is documented in
[`demo/README.md`](demo/README.md) and is the quickest way to see the API above
in use.

## Development

```sh
npm install
npm run build   # type-check, bundle with esbuild, emit declarations
npm run dev     # rebuild on change
npm run demo    # http://localhost:8080 with a wisp server, epoxy and libcurl
npm run lint
```
