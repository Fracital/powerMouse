# Stomp demo

A small host application for Stomp: a landing page with an address bar and
quick links that turns into a browser view (address bar and transport switch
on top, an early-Android style navigation bar at the bottom) around a proxied
frame. The look is adapted
from [Powermouse](https://github.com/Titanium-Network/powermouse); the
behaviour is built entirely on the public `StompController` API, so it doubles
as a reference integration.

## Running it

Node 22 or newer. `demo/server.js` loads `package.json` with the
import-attributes syntax on purpose: older, unsupported Node releases fail at
parse time rather than run the proxy on an unpatched runtime.

```sh
npm install
npm run build          # produces dist/
npm run demo           # http://localhost:8080
```

Environment variables:

| Variable              | Default | Meaning                                                                           |
| --------------------- | ------- | --------------------------------------------------------------------------------- |
| `PORT`                | `8080`  | HTTP port                                                                         |
| `WISP_ALLOW_LOOPBACK` | unset   | Set to `1` to let the wisp server reach `127.0.0.1` / private networks (local QA) |

## What the server does

`demo/server.js` is an Express app plus a [wisp](https://github.com/MercuryWorkshop/wisp-protocol)
server on the same port:

| Path          | Serves                                                  |
| ------------- | ------------------------------------------------------- |
| `/`           | `demo/public` (the page, stylesheet, script, images)    |
| `/stomp/`     | `dist/` via `stompPath` from `stomp-rewrite/path`       |
| `/epoxy/`     | `@mercuryworkshop/epoxy-transport`'s `dist/`            |
| `/libcurl/`   | `@mercuryworkshop/libcurl-transport`'s `dist/`          |
| `/wisp/`      | WebSocket upgrade handled by `@mercuryworkshop/wisp-js` |
| `/api/status` | `{ uptime, version, node }` for the landing page footer |

Nothing else is proxied by the server. All page traffic goes through the
transport, which tunnels through `/wisp/`.

## How the page works

`demo/public/pm/main.js`, in order:

1. **Register the service worker** at `/stomp/serviceWorker.js` with scope
   `/stomp/` and wait until it is `activated`. The landing page itself is
   outside that scope, which is fine: the controller only needs the
   `ServiceWorker` object to talk to.
2. **Load a transport.** The choice is remembered in `localStorage`
   (`stomp-demo:transport`). Transports are plain ES modules served from
   `/epoxy/` and `/libcurl/`, imported on demand.
3. **Create the controller**:
   ```js
   controller = new StompController({
   	serviceworker,
   	transport,
   	directory: '/stomp/',
   	codec: 'xor',
   });
   await controller.wait();
   frame = controller.createFrame(document.getElementById('frame'));
   ```
   `wait()` resolves once the service worker has built a server for this
   controller. The controller is exposed as `window.controller` for devtools.
4. **Autocomplete.** Each keystroke in an address bar asks
   `/suggestions?input=...` for public suffixes matching what was typed after
   the last dot (the server loads the public suffix list at startup, with a
   built-in fallback). Suffixes that start with the typed text come first,
   most common first; clicking one swaps it into the address bar.
5. **Navigate** with `frame.go(url)` on the active tab. Input goes through `SearchBuilder`, so
   anything that doesn't look like a host becomes a search. The proxied URL is
   mirrored into `location.hash`, so a refresh restores the page.
6. **Keep the address bar honest.** `frame.url` reads the real location of the
   proxied document (through its inject client), and the page polls it so
   `pushState` navigations inside the frame show up too.
7. **Tabs.** Each tab is its own `controller.createFrame()`; only the active
   frame is visible. The landing page doubles as the new-tab page: submitting
   there or clicking a quick link opens a new tab. Closing the last tab goes
   back to the landing page.
8. **Navigation bar** at the bottom of the screen, styled after the early
   Android bar: Back steps through the active tab's own history (the demo
   records each page the frame reaches, including `pushState` changes, so
   mashing Back can never walk the host page out of the site; at the start of
   a tab's history Back goes home instead), Home shows the landing page,
   Recents opens the tab manager.
9. **Tab manager**, modelled on the One UI recent-apps screen. The cards are
   the real frames scaled down with CSS transforms (moving an iframe in the
   DOM would reload it), so each card is a live preview. Swipe or drag the
   stack sideways (mouse, touch or pen) to scroll through tabs, or use the
   mouse wheel and the arrow keys. Swipe a card upward to close it. Click the
   centred card to open it, a side card to centre it, the x to close it,
   Close all to close every tab, or one of the full-width quick-link buttons
   along the bottom to open that site in a new tab. Those buttons are the
   home screen's quick-link tiles: opening the manager from the home screen
   slides them from the tiles into the dock, and going home slides them
   back. Closing the last tab returns to the landing page. Enter opens the centred card and Escape
   closes the manager.
   Alt+Left / Alt+Right in the browser view call `frame.back()` /
   `frame.forward()`.
10. **Switching transports** calls `controller.setTransport(...)`. Requests in
    flight finish on the old transport; the next navigation uses the new one.

Errors from any step land in the status line (`Error: ...`) rather than the
console only.

## Transports

Both bundled transports have a defect against `wisp-js` 0.5 (measured with and
without Stomp in the path, see the changelog's known limitations):

- **epoxy** (default): HTTP is fast and reliable; incoming WebSocket frames
  stop after the first round trip.
- **libcurl**: WebSockets work; HTTP stops answering after roughly 160
  requests even with the enlarged connection pool the demo passes
  (`connections: [500, 400, 200]`).

Pick epoxy for browsing, libcurl when you need sockets.

## Files

```
demo/
├── server.js           Express + wisp host
├── public/
│   ├── index.html      landing + browser chrome markup
│   ├── favicon.ico
│   └── pm/
│       ├── main.css    Powermouse-derived styling
│       ├── main.js     controller wiring and UI behaviour
│       ├── noise.png, header-background.png, logo.png
└── README.md
```

## Deploying somewhere real

- Serve the page over HTTPS; the script picks `wss://` for the wisp URL
  automatically from `location.protocol`.
- Keep `dist/`, the transports and the page on the same origin. The service
  worker scope and `directory` must match the path `dist/` is mounted at.
- Run wisp with its default filters (the loopback opt-in is for local QA).
- `Cache-Control: no-store` on `/stomp/serviceWorker.js` is a good idea so
  updates are picked up; the demo relies on `updateViaCache: 'none'`.
