# Dialing (just call stomp)

Dialing is an experimental, opt-in way to show a proxied tab: the frame never
navigates to a site. Each document is written into a fresh frame of one
constant page, the call page, which the service worker serves and controls.
The browser's session history, the frame's `src` and its real location only
ever show the call page. The code is `src/controller/justCallStomp.ts` (the
host), `src/server/called.ts` (the worker and the call page),
`src/inject/dom/calledHooks.ts` and `src/inject/dom/calledFrames.ts` (a
dialed document and its own frames).

## Opting in

```js
const controller = new StompController({ ...init, dialing: true });
await controller.wait();
const tab = await StompController.justCallStomp(frame, 'https://example.com/');
```

Without `dialing: true` there is nothing of it: the service worker serves no
call page (its URL is a URL like any other under the scope, which the host's
server answers), a request that carries the call's header is a request like
any other, the controller gets no token, and `justCallStomp()` throws.

## The call page's URL

Every dialed frame loads `<directory><callPage>`, where `callPage` is an
asset name (`init.assets.callPage`, `StompController.DEFAULT_ASSETS.callPage`,
default `k3v9.html`). A frame of a dialed document loads the same page with
its depth as the query: `?1` below the tab's frame, `?2` below that (Chrome
refuses a frame the URL two of its ancestors have). The URL is the same at
every navigation, reload and step of the tab, and the same for every frame of
a depth.

`callPage` names no file in `dist/`: the worker makes the page. A host that
serves the bundle under neutral names gives the call page a neutral name of
its own too, as it does the others, and serves nothing for it. The URL is only
as neutral as the host's `directory`: the demo's dialing mode uses a scope the
server mints (`STOMP_DIAL_DIRECTORY`, demo/README.md), not `/stomp/`.

## The protocol

All of it is messages: the host never reads or writes the frame's window,
so the call page may be on another origin than the host page.

1. The host routes the URL and asks the controller for a token,
   `controller.callToken(routed)`: 32 lowercase hex digits from
   `crypto.getRandomValues`, which the controller hands its worker over its
   own channel (the `callToken` rpc). The worker keeps it for that route of
   that controller for 45 seconds (`CALL_WAIT_MS`), and refuses it for a
   controller that did not opt in.
2. The host makes the frame (`src` is the call page) and, once it has loaded,
   posts `{ $stomp$call: <token> }` with one `MessagePort` to the frame's
   origin.
3. The call page takes the message only when it is trusted (`isTrusted`),
   comes from its parent window (`event.source === parent`), from an origin of
   a controller that opted in (the worker's own, the site pool's, and
   `frameAncestors`), and, where the browser lists the frame's ancestors
   (`location.ancestorOrigins`, Chrome), from the parent's listed origin; it
   has exactly one key and exactly one port. Firefox lists no ancestors: there
   the parent's window and the origin the browser stamped on the message
   decide, which is the same parent and the same origin. Up to eight such
   messages are taken at once, so a page of the same origin that posts first
   does not shut the host out; only the one whose token the worker holds is
   answered.
4. The call page answers `{ ready: true }` on the port. The host then sends
   `{ call: { routed, type, method, body, referrer, contentType?, policy? } }`.
   `type` is `navigate`, `reload` or `back_forward`; `method` is `GET` or
   `POST`; `routed` and `referrer` are URLs under the scope. The page builds
   the fetch itself (its headers, `mode: 'same-origin'`, `credentials`,
   `redirect`, `cache`), so a caller names no header and no mode.
5. The worker answers the fetch (`x-stomp-call` and `x-stomp-call-token`) as
   that frame's navigation to the route. It spends the token on the call: a
   client whose document is a call page, has not been written yet and
   presents a token held for exactly that route. A redirect within the scope
   is the same call with the same token; one anywhere else ends it.
6. The page answers `{ answered: { url, routed, status } }` or
   `{ failed: <text> }`. The host shows the frame and sends
   `{ write: { url, session } }`; the page writes the answer into itself.
7. From then on the port is the document's. It tells the host
   `{ op: 'navigate' | 'push' | 'replace' | 'step' | 'scroll' | 'token', ... }`
   (`scroll` as it scrolls, `token` for a call of one of its own frames, which
   the host mints and answers as `{ token: { id, value } }`), and the host
   tells it `{ pop: { index, state, scroll? } }`. A step to an entry of
   another document carries the entry's scroll in the session, and the
   document restores it once it has loaded.

Each end checks the shape of everything it hears and drops what does not fit
(`toldOf` and `callAnswerOf` in justCallStomp.ts, their twins in
calledFrames.ts, and the call page's own checks).

## What it does not do

- On the host's own origin (no slot of its own), a script of that origin that
  got past the inject can reach the call page's window: read what is written
  there, or replace its globals before the host's message arrives. The token
  keeps such a script from making calls of its own, not from reading a
  dialed document of its own origin. Only a call page on another origin is
  out of its reach.
- A token lives in the worker's memory: a worker the browser restarts between
  the token and the call refuses the call, and the frame shows nothing (fail
  closed).
- The demo's dialing mode has no site pool and no isolation mode yet.
