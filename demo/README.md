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
| `STOMP_WISP_URL`      | unset   | External wisp endpoint for the transports; when set, `/wisp/` is not served       |
| `STOMP_PROXY_ORIGIN`  | unset   | Origin serving the proxy for isolation mode; empty means same origin              |
| `WISP_ALLOW_LOOPBACK` | unset   | Set to `1` to let the wisp server reach `127.0.0.1` / private networks (local QA) |

They can also live in a `.env` file next to `package.json` (not committed);
the server reads it at startup. The page gets what it needs from `/config.js`.

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
   Android bar: Back steps through the active tab's own history (the frame
   reports whether it can step, from the browser's Navigation API, so mashing
   Back can never walk the host page out of the site; at the start of a tab's
   history Back goes home instead, and on the home screen it does nothing),
   Home shows the landing page, Recents opens the tab manager.
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

## Origin isolation

Opened at `http://localhost:8080`, the page uses `http://127.0.0.1:8080` as
the proxy origin. Same server, two origins, so proxied pages are cross-origin,
sandboxed frames that can neither read the demo page nor navigate it. On any
other hostname the proxy origin comes from `STOMP_PROXY_ORIGIN`; without it
(and at `http://127.0.0.1:8080`) the origins coincide and the demo runs the
same-origin `StompController`, which the version line says. That mode is not a
security boundary: a proxied page that breaks out of the rewriter shares the
origin of the host page. The live demo at https://stomp.fracit.al runs this
way on purpose, with one hostname.

What the isolated mode consists of:

- `dist/controllerFrame.html`, embedded hidden by `RemoteController`. It
  registers the service worker on the proxy origin, loads the transport
  module (which must also live on the proxy origin) and runs the real
  controller. Its `<meta name="stomp-allowed-origins">` lists the host
  origins allowed to drive it, space separated; left empty, it trusts the
  page that embedded it (taken from the referrer once, at load). Set it for
  a real deployment.
- Proxied frames get
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"`.
  `allow-same-origin` is required so the proxy origin's service worker
  controls the frame; `allow-top-navigation` is deliberately absent so
  `top.location = ...` throws instead of navigating the host.
- The service worker adds `Content-Security-Policy: frame-ancestors <host>`
  to every proxied document, so only the host application can frame the
  proxy origin.
- Navigation controls (back, forward, reload) and the address bar's URL and
  title are relayed through the controller frame, which is same-origin with
  the proxied pages; the host page never touches them directly.

## Deploying somewhere real

https://stomp.fracit.al is this directory, deployed by
`.github/workflows/deploy.yml` on every push to `master`: the workflow builds,
then asks terp (the Fracital VPS) over SSH to run `deploy/terp-deploy-gate.sh`
for that commit. The gate clones and builds in `/opt/stomp/stage`, swaps
`/opt/stomp/repo` to it, restarts the pm2 app `stomp` on :8081 and rolls back
if `/api/status` does not come up. terp's OpenResty routes the `stomp.fracit.al`
host to that port (the vhost is in abulxt's `fracital_origin` ansible role,
`fracital_origin_apps`); the abulxt edge fleet terminates TLS and relays to
terp, and Cloudflare fronts the edges with a proxied CNAME. terp's
`/opt/stomp/repo/.env` holds `PORT` and `STOMP_WISP_URL`, which points the
transports at the edges' existing keyed wisp relay (`/pipe/<key>/`, served by
each edge's own wispurr), so the demo server's built-in wisp is off there.

For your own deployment:

- For isolation, use two hostnames: one for the host application, one (the
  proxy origin) for `dist/`, the transports, wisp and the proxied content.
  One server can serve both; the demo server does. Set `STOMP_PROXY_ORIGIN`
  to the second one and fill in `stomp-allowed-origins` in
  `controllerFrame.html`. Cloudflare's universal certificate covers one
  subdomain level, so prefer `name-proxy.example.com` over
  `proxy.name.example.com`.
- Serve the page over HTTPS; the script picks `wss://` for the wisp URL
  automatically from `location.protocol`.
- Keep `dist/`, the transports and the page on the same origin. The service
  worker scope and `directory` must match the path `dist/` is mounted at.
- Run wisp with its default filters (the loopback opt-in is for local QA).
- The page, its scripts and `/stomp/` are served with `Cache-Control:
no-cache` so browsers revalidate and CDNs do not pin a stale service worker
  or shell to a new build; the transports and fonts may be cached for a day.
  The demo also registers with `updateViaCache: 'none'`.
