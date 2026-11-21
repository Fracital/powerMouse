# Dialing (just call stomp)

Dialing is a way to show a proxied tab, opt-in for a host of the library and
the demo's default (demo/README.md, "Dialing"): the frame never navigates to
a site. Each document is written into a fresh frame of one
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
as neutral as the host's `directory`: the demo's page dials on a scope the
server derives (`STOMP_DIAL_DIRECTORY`, demo/README.md), not `/stomp/`.

## The protocol

All of it is messages: the host never reads or writes the frame's window,
so the call page may be on another origin than the host page.

1. The host routes the URL and asks the controller for a token,
   `controller.callToken(routed)`: 32 lowercase hex digits from
   `crypto.getRandomValues`, which the controller hands the worker of the
   route's origin over its own channel (the `callToken` rpc; for a content
   slot, through that slot's agent, `AgentBound.callToken`). The worker keeps
   it for that route of that controller for 45 seconds (`CALL_WAIT_MS`), and
   refuses it for a controller that did not opt in.
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
   is the same call with the same token; one to another origin of the site
   pool (a slot's, or the hub's) ends it as moved there, and one anywhere
   else ends it.
6. The page answers `{ answered: { url, routed, status } }`,
   `{ moved: <route on another origin> }` (the host calls again from a call
   page there, with a token for that origin's worker) or
   `{ failed: <text> }`. A page that has not said it is ready within 10
   seconds gets no call: on a content slot the host leaves the slot out and
   calls from its own origin. The host shows the frame and sends
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

## A dialed document's frames

A frame of a dialed document is called by that document as the tab's frame
is by the host (`calledFrames.ts`). Two things are its own:

- Until its document is written, the frame shows its initial about:blank
  and then its call page, neither of them a document of the page's. The
  browser keeps the initial about:blank's window for a call page of the
  same origin, so nothing may be injected into it (the call page would run
  in the page's realm and refuse its call), and a raw window would run
  nothing of the proxy's. The page's read of the frame's `contentWindow`
  or `contentDocument` then gives another origin's stand-in (the
  document null), and the next read after the frame's document is written
  gives its window (`callPending`, modules/IFrame.ts).
- The call page's own load is over before the frame's document is asked
  for, so the browser would fire the page's `load` with the frame still
  empty. While a frame is called before the page has loaded, the page's
  document loads an image (an element no document has) from the call
  page's path with `?hold=<id>`, which the worker answers only when the
  document lets go of it, or empty after a minute (`callHold`,
  src/server/called.ts): the page's `load` waits until the frame's
  document has loaded or its call ended, as natively. The timing hooks
  leave its entry out (its URL is no page's). A page under a policy of its
  own is not held: the policy could refuse the image, and report it.

## What it does not do

- On the host's own origin (no slot of its own), a script of that origin that
  got past the inject can reach the call page's window: read what is written
  there, or replace its globals before the host's message arrives. The token
  keeps such a script from making calls of its own, not from reading a
  dialed document of its own origin. Only a call page on another origin is
  out of its reach.
- A frame's window the page read before the frame's document was written
  stays another origin's stand-in (natively it is the frame's window from
  the start), and a page under a policy of its own may still see its
  `load` before its frames' documents have loaded.
- A token lives in the worker's memory: a worker the browser restarts between
  the token and the call, or a new worker that took the scope over (a Tor
  profile's, registered again by a new session), refuses the call. The host
  calls a refused GET of its own origin again, twice at most, each time with
  a fresh token and a fresh call page; anything else stays refused, and the
  frame shows nothing new (fail closed).
- A hard reload (`frame.reload({ bypassCache: true })`) tells the worker of
  the host's own origin before the call, which then fetches the document
  and what it loads past the caches; on a content slot it is a reload.
- The demo's isolation mode (`STOMP_PROXY_ORIGIN`, RemoteController) does not
  dial yet, and a browser without the Navigation API cannot: the demo shows
  the classic tabs there, and says so. Its page uses the content slots when
  the server has them
  (docs/content-slots.md); with them each site's call page is on its slot's
  origin (the same path, `<directory><callPage>`), out of reach of a script
  on the host's origin.
