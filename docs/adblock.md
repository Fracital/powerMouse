# The built-in content blocker

STomp can block what a content blocker in the user's browser would block:
ad and tracker requests never leave, the elements the lists name are hidden,
and the lists' scriptlets run in the page. It is on by default; a host
turns it off with `adblock: false`, and then nothing of it is fetched or
run.

```js
const controller = new StompController({
	// ...
	// adblock: false,
});
```

The engine is Brave's `adblock` crate (adblock-rust 0.13.5, MPL-2.0)
compiled to wasm (`rust/block`, shipped as `dist/blocker.wasm`, 1,063 KB and
299 KB with brotli). It reads the filter syntax of EasyList and uBlock
Origin. The plan and the reasons behind the design are in
`docs/rust-plan.md`, section 8.

## The option

`adblock` on `StompController` and `RemoteController`: left out (on, see
"By default"), `false`, `true`, or an object.

| Field       | Meaning                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lists`     | the filter lists: URLs, or `{ url, trusted, format }`. Default: EasyList, EasyPrivacy and uBlock Origin's filters, unbreak, badware, privacy, resource abuse and quick fixes lists |
| `resources` | the URL of the redirect resources and scriptlets, in the format of Brave's `resources.json`. Default: Brave's published set, which is built from uBlock Origin's                   |
| `engine`    | the URL of a serialized engine to load in place of fetching and compiling `lists` (see below)                                                                                      |
| `refresh`   | hours between refreshes of the lists, default 24                                                                                                                                   |

`trusted: true` on a list lets it use the `trusted-*` scriptlets, which edit
a page's cookies, storage and responses. uBlock Origin's own lists are
trusted by default, as in uBlock Origin; a list given as a plain URL is not.
`format: 'hosts'` reads a hosts file.

Nothing is bundled. The lists and the resources are fetched at runtime by
the service worker through the controller's transport, like a page's own
requests, so the list servers see the wisp server's address and never the
user's. The compiled engine is kept in CacheStorage (`stomp-adblock`) with
the resources, keyed by the list URLs and the engine's format, so a
restarted worker loads it in milliseconds and the lists are fetched again
only once the stored engine is older than `refresh`. A list that cannot be
fetched is left out. With no list fetched at all, or no resources, the
blocker stays off and pages load unfiltered; the stored engine, when there
is one, keeps serving while a refresh fails.

The module itself (`blocker.wasm`, named by `init.assets.blocker`, served
from `init.directory` with the other files) is one more of the controller's
wasm modules (`src/wasm/thread.ts`): the controller fetches it once and
hands its bytes to the service worker with the handshake
(`ControllerInitMessage.modules.blocker`), which compiles them on its own
thread. A compiled `WebAssembly.Module` cannot be posted to a service
worker, and nothing else runs the blocker, so the controller never compiles
it and the rewrite workers never get it. When the module cannot be fetched
the controller says so on the console and runs without the blocker.

With `true` or an object, the first navigation waits for the engine, for
five seconds at the most; past that the document loads unfiltered and the
engine serves from the moment it is built.

### By default

A controller that is not given the option runs the blocker with the default
lists, as `adblock: true` does, except that what it cannot have never gets
in the way of a host that did not ask for it:

- A host that does not serve `blocker.wasm` gets one `console.info` line from
  the controller (`Stomp: the content blocker is off, its module did not
load`); no list is asked for and the inject installs nothing for the
  blocker. When the resources or every list cannot be fetched (a wisp server
  that does not reach the list servers), the service worker says it once
  (`Stomp: the content blocker is off: ...`) and pages load unfiltered; a
  single default list that fails is left out without a line. The next
  controller to shake hands tries again. With `true` or an object the module
  and each list that fails are a `console.warn`, as before.
- No navigation waits for the list servers, only for the engine the browser
  stored (milliseconds). With none stored yet (a first visit, or cleared site
  data) documents load unfiltered until the engine is built.

The first handshake waits for `blocker.wasm` either way (fetched beside the
transport's module), so serve it with the cache headers of the other files.

### A prebuilt engine

A host that does not want every browser to compile the lists can build the
engine once and serve the bytes:

```js
adblock: {
	engine: '/assets/engine.dat';
}
```

The bytes are the crate's own serialization (`Engine::serialize`, the
flatbuffers format, version 8). The crate checks the format's version and
nothing else, so only load an engine that the same `blocker.wasm` built
(`OP.addList` for each list, `OP.build`, then the output: see
`test/suites/adblock-engine.mjs` for the dozen lines it takes in node). The
resources are not part of the engine and are still fetched.

## What it does

**Requests.** The service worker asks the engine before a request reaches
the host's rules, the page's emulated service worker, the HTTP cache or the
transport. The request is judged by its real URL, by the real URL of the
document or worker that makes it (for a nested document, the page that
frames it; a top-level document is its own first party) and by its type as
a content blocker would name it: `script`, `stylesheet`, `image`, `font`,
`media`, `object`, `subdocument`, `document`, `xmlhttprequest` for a fetch
or XHR, `ping` for a beacon. In proxy URL space every request is
same-origin with its page; none of that is used.

- A blocked request is a network error, as `net::ERR_BLOCKED_BY_CLIENT` is
  to a page: `fetch` rejects with `TypeError: Failed to fetch`, an image
  fires `error`, a frame shows the browser's error page. There is no status,
  header or body of the proxy's. A blocked top-level document gets the
  host's error page (`init.errorPage`, kind `blocked`) when there is one.
- `$redirect` answers with the resource (an empty script, a 1x1 image) and
  the resource is rewritten like the origin's own answer would have been.
- `$removeparam` sends the request without the parameters; a navigation is
  redirected, so the document's URL is the one fetched.
- `$csp` policies are added to the document's response when the proxy can
  enforce them. The browser applies a policy to proxy URLs, where every
  origin is the proxy's, and the proxy's own shell runs inside the document,
  so only directives whose sources are keywords, schemes or `*` are carried,
  never `sandbox`, and a script policy only when it still allows inline
  scripts and `eval` (`src/blocker/csp.ts`). `worker-src 'none'` holds;
  `script-src 'self'` is dropped. Every carried policy lets one worker
  run whatever it says of workers: the proxy's own for sealed copies, from
  the service worker's route `<directory>sealer`, named by its full URL
  among the policy's worker sources (docs/same-origin-policy.md, the load
  gate).
- The host's request log (`onRequest`) reports a blocked request with status
  0, kind `blocked` and the error `blocked by the content blocker`.

**WebSockets.** A socket never passes the service worker: the page's inject
(a document's or a worker's) opens it on the transport, whose host (the
controller, or its transport worker) lets the controller add the cookie
jar's header to the handshake first. That hook is where a socket is judged.
The controller asks the service worker (one more message each way on the
port they already share, sent beside the question for the cookies, so a
socket waits for nothing new), the worker asks the same engine with the
type `websocket`, the socket's real `ws:` or `wss:` URL and the origin its
handshake carries, which is the real origin of the document or worker that
opened it and all the engine reads of a source (its host, for `$domain` and
`$third-party`). On a yes the hook refuses the handshake
(`HANDSHAKE_REFUSED`, `src/transport/serveTransport.ts`) and the transport
never hears of the socket: no stream is opened on the wisp connection.

- The page sees what it sees natively of a socket a content blocker refused,
  which is what it sees of any socket that could not connect (Chrome for
  Testing 156 with a `declarativeNetRequest` rule): `readyState` goes from
  `CONNECTING` to `CLOSED`, `error` fires, and `close` follows in the same
  task with code 1006, no reason and `wasClean` false. The `adblock` suite
  compares the two sequences in the browser it runs in.
- Sockets opened from a dedicated worker, a shared worker and an emulated
  service worker take the same path and get the same answer.
- Only an explicit refusal fails a socket. With no answer (the service
  worker is restarting, the question took more than the hook's two seconds)
  the socket connects, as every request passes while no engine answers; a
  socket is not a navigation, so it does not wait for an engine that is
  still being built.
- `onRequest` reports a blocked socket like a blocked request (status 0,
  kind `blocked`, destination `websocket`), without a frame: the handshake
  hook does not know which page a socket belongs to. Sockets that connect
  are not reported, as before.
- A `$redirect` rule that matches a socket blocks it, as in uBlock Origin;
  `$removeparam` is not applied to sockets.

**Cosmetic rules.** While it builds a document's shell the worker asks the
engine for the document's URL and hands the answer to the inject before
the page's markup:

- hide selectors become rules of a constructed style sheet the document
  adopts. Nothing is added to the DOM or to `document.styleSheets`, and the
  page's `document.adoptedStyleSheets` reads and writes as the list of the
  page's own sheets.
- the generic rules for classes and ids are not sent with every document
  (the lists hold tens of thousands). The inject collects the classes and
  ids the document really uses from mutation records, asks the worker for
  them in batches, and adds what comes back. The mutation callback only
  queues: the work happens in timer slices, off the typing path.
- procedural filters (`:has-text()`, `:matches-css()`, `:matches-attr()`,
  `:matches-path()`, `:min-text-length()`, `:upward()`, `:xpath()`) and
  action filters (`:remove()`, `:style()`, `:remove-attr()`,
  `:remove-class()`) are interpreted in the page
  (`src/blocker/procedural.ts`), with uBlock Origin's semantics, after every
  batch of mutations. An element a procedural filter hides gets an inline
  `display: none !important`, the only way to name one element; a plain
  selector with `:style()` is a rule of the sheet.
- `$generichide` and `#@#` exceptions are honoured.

**Scriptlets.** The page's `+js(...)` scriptlets are one script, which the
worker rewrites like any script of the page. It runs once the document is
opened for the page's markup and before the page's first script, inside a
function (its helpers never become globals), so what a scriptlet wraps is
STomp's hook and what it sees is the page's own URL: a scriptlet that wraps
`fetch` gets the URL the page passed, and `location.href` is the real page.

With `adblock: false` none of this exists: the config carries no `adblock`,
the module is never fetched, the worker has no engine and the inject takes
no natives and installs no hook.

## Measured

On this machine, node 22, the module as shipped, Brave's main list (6.9 MB,
about 198,000 lines) as the input:

| What                              | wasm                 | native (the crate's own numbers) |
| --------------------------------- | -------------------- | -------------------------------- |
| compile the list                  | 245 to 590 ms        | 82 ms                            |
| load the serialized engine        | 9 to 13 ms           | 1.1 ms                           |
| serialized engine                 | 8.6 MB               |                                  |
| instance memory, serving          | 18.8 MB              | 9.7 MB of heap                   |
| instance memory, while compiling  | 48 MB (then dropped) |                                  |
| one network check                 | 11 to 19 us          | about 5 us                       |
| one document's cosmetic resources | 140 to 175 us        | about 40 us                      |

`ADBLOCK_BENCH_LIST=<file> node test/suites/adblock-engine.mjs` repeats
them. The serving instance is a fresh one that only loaded the serialized
engine; the instance that compiled the lists is dropped with its garbage.

In headless Chrome 152 through the demo (2026-11-10), with the eight default
lists: the lists and the resources were fetched through wisp, compiled and
stored (an engine of 8.5 MB) 1.0 to 1.3 s after the controller was made. A
document then carries 559 generic hide selectors in its shell, and the
requests of a page to an ad server and an analytics script were blocked.

A refused WebSocket reaches its `error` event 0.5 ms after `new WebSocket()`
(median of 25, 1.2 ms at the most; the transport hosted in the page), where
an unlisted socket to a local server opens in 2.6 ms with the blocker on.

## Limits

- The crate does not do HTML filtering (`##^`) or response body `$replace`,
  and drops a whole rule that carries an option it does not know (`popup`,
  `header`, `denyallow`, `replace`).
- WebTransport and WebRTC connections are not judged by the lists.
- A blocker that was built stays in the service worker until the worker
  stops, also when the last controller that asked for it is gone.
- An element whose request was blocked is not collapsed: a blocked image
  keeps its box unless a cosmetic rule hides it.
- Cosmetic rules do not apply inside shadow roots, in `about:blank`,
  `srcdoc` and `blob:` documents, or in XML documents.
- A frame whose parent read its `contentWindow` before its document arrived
  keeps the parent's client (the browser keeps the about:blank Window for a
  document of the same origin). There the lists' selectors hide and the
  scriptlets run, but generic rules by class and id and procedural filters
  do not: they read the document's nodes, and a node the parent's bundle
  reads first is the parent's realm's to the page from then on.
- On wasm the crate never discards a compiled regex (it has no clock), so
  an instance only grows. Past 160 MB of linear memory the worker replaces
  it with a fresh one that loads the stored engine.
- An instance that traps (a Rust panic aborts) is dropped and replaced the
  same way; requests pass unfiltered in between.

## Building the module

`ENGINE=<docker or a wrapper> deploy/rust/build.sh block blocker` builds
`rust/block` in the pinned toolchain container and writes
`assets/blocker.wasm` with its checksum and provenance
(`deploy/rust/README.md`). The crate's features are `full-regex-handling`,
`single-thread` and `css-validation` (without it a procedural rule would be
handed over as a plain selector). The public suffix list is not compiled
in: the module asks the worker (its one import), which already answers
sites for the cookie jar (`src/suffix.ts`: the suffix module under
`rewriter: 'wasm'`, tldts otherwise).

The `adblock` crate is used unmodified from crates.io, pinned to 0.13.5
(`rust/Cargo.lock`); its source is https://github.com/brave/adblock-rust
under the Mozilla Public License 2.0.
