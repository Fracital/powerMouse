# Changelog

## 2.0.0

The first release after a four-year gap. Everything below is breaking.

### Build

- webpack and swc-loader are replaced by esbuild (`build.js`). Type checking
  (`tsc --noEmit`) and lint (eslint 10, flat config) run as separate scripts.
- Bundles that expose a classic-script global now define it with
  `Reflect.defineProperty` so it stays configurable.
- An ESM entry (`dist/controller.mjs`) with declarations is published as the
  package main; `stomp-rewrite/path` keeps exporting `stompPath`.
- Rust/wasm artifacts (`docs/rust-plan.md`): the crates under `rust/` are
  built by `deploy/rust/build.sh` in a toolchain container pinned by image
  digest and download checksums, checked for custom sections, undeclared
  imports or exports and project tokens in the bytes, and committed under
  `assets/`, which the build copies into `dist/`. The first is
  `rewriter.wasm` (`init.assets.rewriter` names it), the JS rewriter's
  boundary with a copying body, loaded through `src/wasm/module.ts`: one
  compiled `WebAssembly.Module` from a URL, bytes or a module the host
  compiled, never from `import.meta.url`. Nothing uses it yet; the
  `rewriter: 'wasm'` option comes with the rewriter itself.

### Transport

- `@tomphttp/bare-client` and the `bareServer` config option are gone. Traffic
  goes through a `@mercuryworkshop/proxy-transports` transport.
- The transport is owned by a `StompController` in the host page. The service
  worker and every proxied document and worker reach it over MessagePorts
  (`src/transport/`), so a page never needs the transport module itself.
- Proxied content lives in frames (`controller.createFrame().go(url)`). The old
  `Bootstrapper.navigate()`, which navigated the top-level page, is removed
  because nothing would host the transport afterwards.
- The service worker is registered by the host and no longer takes
  `?config=` on its URL; configuration arrives with the controller handshake.
  The `/process` and `/client` routes are removed.
- `Set-Cookie` headers on WebSocket handshakes are no longer applied to the
  page: proxy-transports does not expose them.
- HTTP/3 (`TransportDescriptor.http3`, off by default): an origin that
  advertises h3 (`Alt-Svc`, an HTTPS DNS record when `dns` names a
  DNS-over-HTTPS server, or `force`) gets its requests over QUIC once a
  connection is up, as Chrome does; quic.nginx.org reports h3 through the
  proxy. The QUIC datagrams ride a wisp UDP stream from epoxy's
  `connect_udp`, through stomp-h3 (quinn and h3 in wasm, built from
  `deploy/epoxy/h3/` into epoxy-transport's `dist/h3/`, loaded only when an
  origin offers h3). Requests never wait on a handshake that has not worked;
  a failed one marks the origin broken (5 minutes, doubling), a wisp server
  without UDP turns QUIC off for a while, and the request goes over the
  transport as before. Chrome's QUIC transport parameters, 256 KiB header
  sections, Chrome's pseudo-header order, no 0-RTT. `Http3Transport` is
  exported for hosts that construct transports themselves. Needs a wisp
  server that relays UDP (the demo's does, and the holyWisp edges do since
  abulxt 853761c7). docs/http3.md has the design and the limits (http3 and
  http3-fallback suites).
- A lost wisp connection no longer leaves the proxy dead until the page is
  reloaded. Epoxy keeps a wisp multiplexor whose WebSocket went away (a
  port forward or a proxy dropping it) as its connection: every request
  after that failed at once with MuxTaskEnded, and one handed a pooled
  connection over it could wait forever. One drop 1.5 s into a YouTube load
  left the page half drawn. A transport built from a descriptor now builds
  itself again (a new wisp connection, an empty pool) the first time a
  request reports the connection gone, and sends again the requests that
  never went out and the GET, HEAD and OPTIONS requests without a body that
  lost their connection before the response head, including those still
  waiting on the old connection, as Chrome does on a reused connection. A
  QUIC connection whose wisp stream ends is closed at once, so its requests
  go over the base transport instead of waiting 30 s for the idle timeout
  (wisp-reconnect and http3-fallback suites).
- A UDP stream the wisp server refuses turns HTTP/3 off for its origin, not
  for the session. One refused stream (a relay that will not send UDP to
  one name, a blocked host, a name that does not resolve) was read as "this
  relay has no UDP" and cost every origin its HTTP/3 for 5 minutes. The
  relay is now taken to have no UDP only on evidence about the relay: it
  says so (a wisp v2 server without the UDP extension), or it refused
  streams to 8 distinct hosts, with close reason `0x48` or `0x42` or none
  reported, while no datagram had come back over the wisp connection. A
  datagram back on any stream withdraws that, and a new wisp connection
  starts from nothing, the origins the old relay refused included. A
  refused origin falls back as before (its requests go over the base
  transport at once, its stream is not asked for again with each request).
  `Http3Transport.info()` gains `udpCarried`, `udpRefused` and
  `altSvc[].refused`. deploy/epoxy's patch 0058 gives a UDP stream
  `closeReason()`, which the transport reads where it exists; the pinned
  epoxy-transport build has it (EpoxyTransport dist 07d0aa4), and with a
  build that does not, every refusal counts as one with no reason
  reported. docs/http3.md has the rule (5) and
  what each wisp server sends (http3-fallback and demo-http3 suites, with
  `test/wisp-gate.mjs`, a relay that refuses UDP per name).

### Demo and API

- The demo has HTTP/3 on by default (`npm run demo`, `npm run dev` and every
  test run's demo server): its epoxy descriptor carries `http3`, so a
  proxied page reaches a site that offers h3 over QUIC, as the user's own
  Chrome does. Some sites judge a session by it: YouTube refused most watch
  sessions that reached it over TCP from one measured machine, Chrome's own
  included, and almost none over QUIC (Known limitations, docs/http3.md).
  `STOMP_HTTP3=0` on the server turns it off, `?http3=0` on the page for one
  visit, and `?http3` turns it on for one visit where the server has it off;
  `STOMP_HTTP3=1` still means on. The cost is bulk downloads: about half
  the speed of HTTP/2 through the same wisp server (20 MB from
  dl.google.com at 5 to 8 MB/s against 7 to 18), small requests the same.
  Where QUIC cannot be had (a wisp server that refuses UDP, an origin whose
  QUIC does not answer) the page and its requests go over HTTP/2 without
  waiting for it (demo-http3 suite). The library's default is unchanged:
  `TransportDescriptor.http3` is off unless a host sets it.
- A controller whose host gives no `id` keeps one from visit to visit, where
  it got a new random one with every page. Every routed URL starts with the
  id, so a script's routed URL is now the same on the next visit: the rewrite
  cache, whose key includes the address, has its output (every script was
  rewritten on every visit), and a browser keeps a script's compiled code by
  its URL. The ids are kept in the host origin's `localStorage`
  (`kept-tab-ids`, 16 at most) and each is held by one controller at a time
  with a Web Lock: a controller takes the id it had before its tab reloaded,
  else the oldest one nobody holds, else a new one, so two tabs open at once
  are still two controllers side by side. A `RemoteController` keeps them on
  the host's origin and hands the controller frame its id. The claim is not
  instant: `id` and `config.directory` are empty until the controller has its
  id, which it does before `wait()` resolves, and nothing is routed or
  registered before that. Without Web Locks or storage, or where they refuse,
  the id is a new random one that is not kept, as before; a host that passes
  its own `id` is as before (an empty one now counts as none, where it was a
  TypeError). What it costs: the id is as random as before and
  only the host's origin reads where it is kept, but it now lasts, and it is
  in every routed URL: a proxied page is never shown one, and a page that got
  one through a hole in the hooks would have a name for the browser that
  outlives the site's cookies. So `cookies.clear()` without an origin, which
  forgets every site's cookies, forgets the kept ids too (the next page, and
  every open tab at its next reload, gets a new one), and they go with the
  host origin's site data. There is no new API and no option for it.
  (controller-ids suite.)
- A built-in content blocker, on by default: `init.adblock` on
  `StompController` and `RemoteController` (docs/adblock.md), `false` to
  turn it off. A host has to serve `blocker.wasm` from `directory` with the
  other files; one that does not keeps working without the blocker, with
  one `console.info` line, and so does one whose wisp server does not reach
  the list servers. Left out, the option never makes a page wait for the
  lists (`true` and an object wait for the first build, five seconds at the
  most). The engine is
  Brave's adblock-rust 0.13.5 compiled to wasm (`rust/block`, shipped as
  `dist/blocker.wasm`, 1,063 KB, 299 KB with brotli, MPL-2.0; named by
  `init.assets.blocker`), so it reads EasyList and uBlock Origin syntax.
  Nothing is bundled: the service worker fetches the lists and the redirect
  resources through the controller's transport (the list servers never see
  the user's address), compiles them once and keeps the serialized engine
  in CacheStorage, where a restarted worker loads it in about 10 ms; the
  lists are fetched again once a day (`refresh`). `true` uses EasyList,
  EasyPrivacy and uBlock Origin's lists; an object names other `lists`
  (`trusted` for the ones allowed `trusted-*` scriptlets, `format: 'hosts'`
  for a hosts file), the `resources`, or a prebuilt `engine`.
  - Requests: the worker asks the engine before the host's rules, the cache
    and the transport, with the request's real URL, the real URL of the
    document that makes it and its type as a content blocker names it. A
    blocked request never reaches the transport and is a network error to
    the page, as `net::ERR_BLOCKED_BY_CLIENT` is; `$redirect` answers with
    the resource, `$removeparam` sends the request without the parameters,
    `$csp` reaches the document where the proxy can enforce it. `onRequest`
    reports a blocked request with status 0 and kind `blocked`.
  - Cosmetic rules: hide selectors are rules of a constructed style sheet
    the document adopts (nothing in the DOM, and the page's
    `document.adoptedStyleSheets` stays its own list); generic class and id
    rules are asked from the worker for the classes and ids a document
    really uses; procedural filters (`:has-text()`, `:matches-css()`,
    `:upward()`, `:xpath()` and the rest) and action filters (`:remove()`,
    `:style()`, `:remove-attr()`, `:remove-class()`) run in the page.
  - Scriptlets (`+js(...)`) are rewritten like a page's script and run before
    the page's first script, over STomp's hooks.
  - The module travels as one more of the wasm modules
    (`ControllerInitMessage.modules.blocker`, bytes the service worker
    compiles); the rewrite workers never get it. With `adblock: false` the
    module is never fetched, the worker has no engine and the inject installs
    nothing.
  - WebSockets: a socket never passes the service worker, so the controller
    asks it from the hook that adds the cookie header to the handshake (one
    more message each way, beside the cookie question), with the type
    `websocket`, the socket's real URL and the origin that opens it. A
    listed socket is refused before the transport hears of it (the hook
    rejects with `HANDSHAKE_REFUSED`; any other failure of the hook, and a
    hook that stalls, let the socket through as before) and the page sees
    what it sees natively of a socket a content blocker refused: `error`,
    then `close` with 1006 in the same task, both reading `CLOSED`. The same
    holds for a socket opened from a dedicated, shared or emulated service
    worker. `onRequest` reports it with destination `websocket`.
  - Not yet: a blocked element is not collapsed, and cosmetic rules do not
    reach shadow roots or `about:blank`, `srcdoc` and `blob:` documents. In
    a frame that keeps the client of a parent that read its `contentWindow`
    early, only the hide selectors and scriptlets apply (docs/adblock.md).
    The crate does no HTML filtering or `$replace`.
  - The demo has it on: `STOMP_ADBLOCK=0` turns it off (`?noadblock` for
    one visit, `?adblock` on for one, the Block ads toggle is remembered).
    A test run asks nothing of the list servers: the demo page's controller
    is given a fixture list (`STOMP_ADBLOCK` as JSON) and the run's wisp
    refuses the list servers (`WISP_BLOCK_HOSTS`). Suites: `adblock-engine` (node:
    the engine's decisions, types, CSP, cosmetic answers, trust, storage) and
    `adblock` (browser: a blocked request never reaches the site, elements
    are hidden, scriptlets run, off changes nothing, and by default the
    lists come through the transport, a host without the module or the
    lists works unfiltered, and no navigation waits).
- `init.rewriter` on `StompController` and `RemoteController` (`Config.rewriter`,
  `'js'` by default) chooses the rewriter backend (docs/rust-plan.md). With
  `'wasm'` the controller loads the Rust modules named by `init.assets` once
  and compiles them once: every rewrite worker gets the compiled
  `WebAssembly.Module` beside its port, and the service worker gets the bytes
  with its handshake (or as soon as they are loaded) and compiles them on its
  own thread, because a message holding a `WebAssembly.Module` never reaches
  a service worker (it is an agent cluster of its own; Chrome fires
  `messageerror`, and a handshake that carried one would be lost). Each
  thread instantiates a module on first use (`src/wasm/thread.ts`): one that
  is missing, declines a call or traps is answered by the JavaScript rewriter
  for that call, so the option changes speed, never output. The first module
  that answers is the scanner (next entry); the Rust JS rewriter comes
  behind it. The demo reads `STOMP_REWRITER=wasm` (`?wasm` for one visit,
  `?js` for the JavaScript rewriters), and the `wasm-share` suite checks
  that every thread holds the modules.
- With `rewriter: 'wasm'` stylesheets are rewritten in a Rust module,
  `scanner.wasm` (`rust/rwcss`, 49 KB, 20 KB brotli; `init.assets.scanner`
  names it), which also finds a document's inline scripts, styles and
  `<base href>` for prewriting (the three expressions of `src/prewrite.ts`
  in one pass). The module is css-tree's tokenizer and parsers ported (the
  lazy parse of a sheet, the full parse of a value, a selector or an
  at-rule prelude) with the rewrite itself: it decodes each URL, asks the
  thread what it routes to (one call per URL through the module's routing
  import: the base URL and the codec stay in JavaScript), and splices the
  result into the text. The output is the JavaScript rewriter's byte for
  byte: 2,396 real stylesheets (69.7 MB) and 560,000 fuzzed stylesheets,
  declaration lists and values rewrite the same both ways. The 99 sheets
  of the corpus (11.9 MB) take 77 ms against css-tree's 553 ms. The module
  declines no text: a lone surrogate, a byte order mark, a routed URL of
  megabytes and nesting by the thousand are its own to answer (the text is
  encoded straight into a buffer the module keeps, and a surrogate with no
  other half crosses as the bytes of its code point), so css-tree only
  rewrites on a thread with no module and for a `data:` stylesheet nested
  past the fourth inside a stylesheet. Two answers are the module's own.
  Past 1,024 nested blocks or brackets the rest is raw text whose url()s
  the expression routes (css-tree does that or throws, from 1,400 to 3,000
  levels by the state of the stack). A sheet of more than 16.7 million
  UTF-16 units is rewritten to its end, where css-tree stops parsing at
  that point and an `@import "x"` after it went out unrouted.
  `onRequest` says which rewrote a stylesheet (`rewriteBy`: `wasm` or
  `js`). The service worker's `/css/` route and the inline styles of a
  prewritten document use it (a worker that was restarted waits the few
  milliseconds its compile takes, so its first stylesheet is the module's
  too), and so does the page: a proxied top's
  rewriter library holds the module beside the script rewriter's and
  rewrites the style elements, style attributes and CSSOM text a page's
  script writes with it (`css-inject-backend` suite), css-tree until it
  has arrived. A closing bracket with nothing open (`a{} } b{}`) is
  answered too, as css-tree answers it now that its parse no longer depends
  on the sheet before (Fixes). The `scanner-parity` suite compares both on
  hand-written cases, the fixture pages and a seeded fuzz.
- With `rewriter: 'wasm'` scripts are rewritten by the Rust rewriter
  (`rust/rwjs`, oxc; `assets/rewriter.wasm`, 454 KB, 160 KB brotli) in the
  rewrite workers and the service worker. It makes the same rewrites as the
  JavaScript rewriter as edits to the script's own text, so everything it
  does not touch comes out byte for byte: comments, spacing, literals, line
  numbers. Over the 46 MB corpus of CNN, Discord and Docs scripts it takes
  2.0 s where the JavaScript rewriter takes 13.6 s, and Discord's 12 MB
  bundle whole in 0.43 s, so a script is no longer split across workers
  under `'wasm'`. A script the module declines (one its parser refuses, a
  BigInt key in a pattern beside an unforgeable) is rewritten by the
  JavaScript rewriter, as is everything while a thread holds no module:
  none of the corpus's scripts and none of the suites' pages' is declined.
  A script no browser runs (a V8 intrinsic, `"use strict"` under a
  parameter pattern) goes out as it came without the JavaScript rewriter
  being asked, and where a thread holds the module its parser also answers
  whether a `javascript:` URL's body is one expression and whether a
  blob's text is a script. The two backends are compared
  without a browser by `rust/host/parity.mjs` (814 cases by rewrite family
  and by hole, run by the `rewriter-parity` suite, and the corpora: no
  difference), and `rewriter-unit` and the browser suites run under both
  (`STOMP_REWRITER=wasm`). `'js'` stays the default.
- Under `rewriter: 'wasm'` a script the browser refuses to compile is
  refused through the proxy as it is natively. The module's parser reports
  no early error (a name declared twice, `with` or a legacy octal literal
  in strict code, `break` outside a loop, a private name no class
  declares, a regular expression that does not compile), so such a script
  was rewritten: the page read its SyntaxError at another line and column,
  and `'use strict'; delete location` ran, as a call of the access API.
  The module now checks them itself in one walk after the parse
  (`rust/rwjs/src/early.rs`; oxc's semantic pass costs 115 KB and refuses
  Annex B scripts a browser takes) and answers such a script as one no
  browser runs: it goes out as it came and the browser reports its own
  error at the page's own position. Syntax no browser has yet (decorators,
  `accessor` fields, `import.defer()`) stays the JavaScript rewriter's to
  decide. `delete` of a bare name (`delete top`) keeps the name under both
  rewriters, since eval code is strict by a caller no rewrite sees and V8
  has to refuse it there. The check is held to V8's verdicts on
  `rust/host/early-errors.txt`, 4,418 texts written from the
  specification's early-error clauses and Annex B and tried in 17 places
  each (`rust/host/early.mjs`, run by `rewriter-unit`; the crate's tests
  read the record): of 45,485 scripts V8 refuses none runs rewritten, of
  29,607 it takes none goes out unrewritten or broken, and what falls
  short of V8's answer without being either is named in
  `rust/host/early-known.txt`. The new `early-errors` suite holds the
  record to Chrome and compares the texts natively and through the proxy
  as `new Function`, eval, inline and fetched scripts, `import()` and
  workers. Over real scripts (the 46 MB corpus, the suites' pages, 2,346
  files of `node_modules`) nothing V8 takes is answered as an error. It
  costs 16 KB of the artifact (5 KB brotli) and 12% of the module's
  rewrite time. The same table lists what the JavaScript rewriter does
  with the texts (12 that run though V8 refuses them, 120 its parser
  refuses though V8 takes them, 11 it prints into a SyntaxError); those
  are not changed here, and the wasm backend still inherits the first
  kind for scripts its own parser refuses.
- With `rewriter: 'wasm'` the page rewrites with the module too (`eval`,
  `new Function`, string timers, written and inserted scripts, every path
  of the inject). A proxied top asks its controller for the compiled
  module, through the service worker, and the rewriter library it shares
  with its frames instantiates it: one instance per top, none per frame,
  and the JavaScript rewriter until it has arrived and wherever it cannot
  (a tab in another agent cluster, a sandboxed document with an opaque
  origin). docs/rust-plan.md has the measured plan for
  taking the JavaScript parsers out of the inject bundle after it (814 KB
  to at most 416 KB).
- The JavaScript rewriter is no longer in the inject bundles. meriyah,
  escodegen, css-tree, tldts and STomp's rewriters on them are one file of
  their own,
  `dist/rewriterLib.js`, named by the new `init.assets.rewriterLib`:
  **a host has to serve one more file**, beside the other bundles, and a
  host that vendors a list of files has to add it to the list. The
  controller fetches it when it starts and `wait()` rejects, naming the
  key, when the host does not serve it. `dist/injectDocument.js` goes from
  860,006 to 428,139 bytes (224,309 to 114,967 brotli) and
  `dist/injectWorker.js` from 440,982 to 214,001; `rewriterLib.js` is
  471,109 (122,541 brotli). What the bundles keep is the glue of the wasm
  modules: with `rewriter: 'wasm'` a script, a stylesheet and a host's
  site are answered by the modules once a top holds them, and by the file
  before that and for what they decline. Every proxied frame fetched,
  scanned and kept the larger bundle; only a top ever ran the library in it. Now the
  service worker writes the file's script into a proxied top's shell,
  before the bundle: with `rewriter: 'js'` the top's library is made from
  it, with `'wasm'` the top keeps it for the first rewrite its module has
  not arrived for or declines, and a frame shares its top's as before. A
  top's first page-side rewrite is answered 3 to 5 ms sooner than when the
  bundle carried the library (`measure-first-rewrite`). A frame under a
  top of another build loads the file with one synchronous request the
  first time it rewrites, and so does a worker: with `rewriter: 'wasm'` a
  dedicated worker only for what its module has not arrived for or
  declines (below), a shared worker for all of it. The file is asked for as
  `rewriterLib.js?<hash of its bytes>`, so a host may answer that URL
  `immutable` (the demo does, when the hash is the file's own). The heap
  one proxied frame adds does not change (a frame never evaluated the
  library); `frame-cost`'s bundle budget goes from 850 to 430 KB. New
  suite `rewriter-fallback`; `client.rewriteCounts` says how a page's
  rewrites went (the module, declined, before it arrived, the library).
- With `rewriter: 'wasm'` a page's dedicated workers rewrite with the module
  as well (`eval`, `new Function`, string timers, `importScripts` and
  `import()` of data: URLs, the bootstrap of a worker they start). The
  context that starts a worker posts it the compiled module with its
  transport port: nothing is compiled again (0.1 ms to instantiate, about
  250 KB a worker), a frame's workers get its top's, a worker's workers
  its own, and a page's service worker the controller's. A 280 KB function
  made from text in a worker takes 14 ms where the JavaScript rewriter
  takes 112 ms. What a classic worker evaluates while its own script runs,
  and what a worker started by a page's first script evaluates before the
  module has reached the page, is still the JavaScript rewriter's (the
  file above, loaded then), as is everything in a shared worker
  (docs/rust-plan.md, "A page's workers"; `worker-rewrites` suite).
- A thread keeps the instance of a wasm module it rewrote with only while
  the instance is small (`src/wasm/thread.ts`). wasm memory never shrinks,
  and an instance ends a rewrite holding 10 to 34 times the script's
  length: one that ends a call holding more than 8 MB in a page's library
  or a dedicated worker, or more than 64 MB in the service worker or a
  rewrite worker (the limit they already had), is replaced by a new one
  from the same compiled module after the call (0.1 to 0.6 ms, and Chrome
  gives the memory back when it next collects the thread's heap). A page
  that evaluates one 1.2 MB string no longer holds 27 MB for the rest of
  its life, and pays 9 ms more the next time it evaluates one.
- With `rewriter: 'wasm'` a rewrite made during a rewrite is the module's
  too: a `data:` module a module imports, or a `data:` stylesheet a
  stylesheet imports, is rewritten from inside the rewrite of the one
  around it, and was the JavaScript rewriter's or css-tree's because an
  instance cannot be entered twice. Such a call now runs in a second
  instance of the same compiled module (up to four deep, each with its own
  route; `wasm-instances` suite).
- The wasm rewriter's glue asks a module only when it answers the revision
  the glue was written against (`wasm-rewriter-glue` suite). The module is
  fetched apart from the bundles, and an older `rewriter.wasm` served
  beside newer ones (the first artifact answered every call with its input)
  would hand scripts back as the page wrote them: such a module is never
  asked, and the JavaScript rewriter answers.
- Under `rewriter: 'wasm'` `onRequest` says which backend rewrote a script
  made now (`rewriteBy`: `wasm`, or `js` when the module declined it, its
  thread does not hold the module yet, or the script was split), as it says
  for a stylesheet.
- Under `rewriter: 'wasm'` a script that holds a lone surrogate (a string a
  page evaluates can; a script from the network cannot) is rewritten by the
  JavaScript rewriter: it has no UTF-8, and the module would have been
  handed U+FFFD in its place and written that into the page's text
  (`wasm-rewriter-glue` suite).
- `suffix.wasm` (`rust/suffix`, `init.assets.suffix`): the public suffix
  list as a table in a wasm module of 81,416 bytes (38,783 brotli), which
  answers what tldts's `getDomain` and `getPublicSuffix` answer for any
  string, with or without the private section. The list is vendored and
  pinned by commit and sha256 (publicsuffix/list 52b71b3c, 2026-10-17, the
  list of the tldts the lockfile pins). `rust/host/suffix.mjs` compares the
  two over every rule, the hosts in the test data, IDN, IP and malformed
  forms and a seeded fuzz (5.5 million comparisons, no differences); the
  `suffix` suite runs it and holds the artifact to a size budget. Under
  `rewriter: 'wasm'` the service worker asks the module for a request's
  site, a route's partition, the cookie jar's public suffix and the
  blocker's registrable domain, and a proxied top's rewriter library asks
  it for the frames under it; tldts answers under `rewriter: 'js'`, until
  the module has arrived and whenever it declines, and stays in both
  bundles for now (docs/rust-plan.md, phase 2).
- A document knows its own site from its shell: the service worker writes
  in what the list says of the document's host, of its top's and of every
  name above them, and the inject asks the rewriter library's list only
  about a host no shell named (a navigation to another host, a cookie
  `Domain` that is no name of the document's host). Before, a document's
  site key, storage partition, cookie key, cookie `Domain` and
  `document.domain` checks each went to the library's copy of tldts (a
  call into the top's library realm, or a copy of the library evaluated
  for it in a document that shares none), which is what kept tldts in the
  inject bundle. `frameElement` compares the two documents' site keys, as
  the window membrane does (`site-facts` suite).
- A site ends at the public suffix list's private section everywhere, as
  in Chrome: two customers of `github.io` are two sites. Three places asked
  the ICANN section alone and took them for one: the site the window
  membrane compares windows by (a page of one read the other's frame, and
  the frame its parent), the SameSite decision for a WebSocket handshake's
  cookies (the other site got Strict and Lax cookies) and
  `document.domain`, which took `github.io`. The shell carries two answers
  for a name instead of three, and the rewriter library's `domain` and
  `publicSuffix` answer with the private section alone. A context in a
  partition (a frame under another site's page, or under a frame of
  another site) has only its `SameSite=None` cookies, as in Chrome: its
  `document.cookie`, its Cookie Store API and its service worker's read
  no `Lax` or `Strict` cookie and keep none they write (the Cookie Store
  API rejects such a write, and any deletion, with Chrome's TypeError),
  and its requests and WebSocket handshakes carry none (the handshakes
  now carry its Partitioned cookies too). A response to a request whose
  site for cookies is another site, or that another site started, other
  than a top-level navigation, sets `SameSite=None` cookies alone.
  Measured against Chrome 152 and 156 with names under `github.io`,
  `blogspot.com`, `s3.eu-west-1.amazonaws.com` and `cloudfront.net`, and
  under `co.uk` as the control (`test/private-sites.mjs`; rows in
  `samesite`, `sop-partitions` and `site-facts`).
  Not changed, and listed in `site-facts`: Chrome holds a window by origin
  where the membrane compares sites, and `Origin-Agent-Cluster: ?0` is not
  honoured (docs/same-origin-policy.md).
- The demo server's pages are cross-origin isolated: every response carries
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: credentialless` and
  `Cross-Origin-Resource-Policy: cross-origin`, so a proxied page that
  isolates itself natively is isolated in the demo. `STOMP_ISOLATION=off`
  leaves the headers out. The page's own loads of other origins (the commit
  list's avatars) go without cookies under that policy. The test runner
  starts its demo servers without the headers except for the two suites
  that need them (`STOMP_ISOLATION=on npm test -- <suite>` runs any suite
  under an isolated host).
- The project is written STomp in prose: the READMEs and docs, code comments,
  the package description, and the demo's page text (its error page, page
  description and version line). Machine-read names (the npm name, files,
  routes, URLs, environment variables, storage and message keys) and every
  string in `dist/` stay as they were. README.md links holyWisp, the wisp
  relay stomp.fracit.al runs on.
- Opening a card in the demo's tab manager also hides the manager's own
  controls at once (the tab count, the new-tab button, Close all and the
  quick-link dock). They faded out over about 250 ms above the opening page,
  as the other cards did; only the backdrop still fades, under the card
  (switcher-geometry suite, desktop and phone widths, entered from the home
  screen and from a tab).
- Opening a card in the demo's tab manager hides the other cards at once,
  as One UI's switcher does. They used to fade out over about 250 ms above
  the opening page (every card's bar and close button is drawn over every
  page), so a neighbour's bar and close button showed through it, and a
  later tab's page faded over it (switcher-geometry suite, desktop and phone
  widths).
- A card in the demo's tab manager shows the whole tab as the browser view
  does: its bar has Back, Forward and Reload, greyed out as they would be for
  that tab, beside the tab's own URL and the status, above the page. The bar
  is a picture (a press anywhere on the card opens the tab), laid out like
  the live bar piece by piece at any width, so opening a card lands each
  button and the address box on its live counterpart without a jump. An
  opening card no longer shows the previously active tab's URL while it
  expands (switcher-geometry suite, desktop and phone widths).
- The browser view's address bar has Back, Forward and Reload buttons with
  the Tango icons vibeOS's web app uses (public domain, `demo/public/pm/icons/`).
  They act on the active tab: Back and Forward step its history and are
  greyed out with nowhere to go (the frame's Navigation API says, else the
  tab's own list), and Back at the start stays in the tab where the
  navigation bar's goes home (toolbar suite).
- The demo's home page shows the repository's latest commits as a git log
  (avatar, message, author and age, short sha, each linking to the commit)
  from `/api/commits`, and links to Fracital and vibeOS beside the title
  (demo suite). The list is the server's own checkout's git log, so
  GitHub's rate limit (60 API requests an hour per address) never empties
  it; avatars come from GitHub's avatar host by email. Without a checkout,
  or with `STOMP_REPO` naming another repository, GitHub's API is asked in
  the background at most every ten minutes, conditionally, never before a
  refusal's reset time (`GITHUB_TOKEN` raises the limit), and its last
  answer is kept on disk across restarts.
- `membrane` (both controllers, on unless `false`): the setting for the
  window membrane, which will hand a page every window and every object of
  another window's realm through a proxy that checks on each use which site
  the window shows now. The setting travels with the config into every
  document the page makes (the top page, frames of its own and of another
  site, about:blank and srcdoc children), and each document's client knows
  the site it compares windows by (scheme, registrable domain and port, none
  for an opaque origin). Nothing uses it yet: both values behave alike until
  the membrane lands (membrane-flag suite, both modes).
- `names.error`: the global the worker writes into the host's error page
  (`globalThis.stompError = { url, status, error, kind }`) is the fifth
  configurable helper name, default `stompError`, validated like the others.
  A host whose build renames identifiers in its vendored pages (the example
  error pages read `globalThis.stompError`) sets it to the name its page ends
  up reading, so the worker's template and the page agree (error-page suite).
- `NavigateInfo.icon`: the page's icon as the page declared it (the first
  `<link rel="icon">` or `shortcut icon`, else the first `apple-touch-icon`,
  resolved against the real URL; null without one), in every navigate report
  and reported again when the page swaps it, so a host never reads the
  frame's DOM for a favicon. `controller.unroute(url)` on both controllers:
  the real URL a routed one stands for, the inverse of `route()` with the
  controller's codec, null for anything that is not a route (navigate-events
  suite).
- `controller.build` on both controllers and `BUILD` exported from the
  controller module: the build identifier baked into the bundle (version plus
  commit, or the package version), which only the `stale` event exposed. The
  worker's build stays `config.build`; `stale` says when they differ (version
  suite).
- `hooks` on `StompController` and `RemoteController`: host code run inside
  every proxied realm, scramjet's `Frame.hooks.init.pre` and `post` by name,
  as scripts that travel rather than closures (a realm on the proxy origin
  cannot reach the host's objects). `hooks.init.pre` runs before the inject
  installs its hooks and `hooks.init.post` after, before the page's first
  script (after the document re-open a written page goes through, so
  listeners survive); in the page, its nested frames, about:blank children,
  popups and srcdoc frames, and with `hooks.workers` in dedicated and shared
  workers. Each phase is `{ source }` (the text) or `{ url }` (fetched once at
  construction; its text is what travels, so a redeploy of the file needs a
  new controller). The code runs raw with the realm's real globals and one
  argument: `{ url, origin, isTop, nested, kind, phase, names, frameId,
window }`, `frameId` being the controller's id. It is trusted host code,
  and what it leaves on the window is reachable by the page. A throw never
  reaches the page: it is logged in the realm and reported to the host as a
  `hookerror` event, `onHookError` and `controller.hookErrors`; a URL that
  cannot be fetched is reported the same way and the controller serves
  without it. A bad shape is a `TypeError`. Types `InitHooks`, `HookScript`,
  `HookContext` and `HookErrorInfo` are exported (realm-hooks suite, both
  modes).
- `names` on `StompController` and `RemoteController`: the four global names
  the rewriter and the inject bundles use (`access` for the API every
  rewritten script calls, `client` for the client on the window, `globalProxy`
  and `globalName` for the markers on the `location` and `eval` stand-ins;
  defaults `$s$j`, `$P$s`, `$s$L`, `$s$N`) can be a deployment's own. They
  travel in the config: the worker rewrites with them, the shell hands them to
  the inject, and about:blank children and workers inherit them. A name that
  is not an identifier, a reserved or special word, a global a plain window
  has, used twice, or an unknown key is a `TypeError` from the constructor.
  `DEFAULT_NAMES` and the `HelperNames` type are exported (helper-names
  suite, a StompController and a RemoteController built with random names;
  the tells fixture takes the names to look for).
  suite; the tells fixture takes the names to look for).
- Several controllers share one directory: two host tabs on `/stomp/` no
  longer replace each other in the service worker. Every `StompController`
  (and `RemoteController`) has an id (`init.id`, 1 to 32 characters of
  `[A-Za-z0-9_-]`, 8 random ones the controller keeps by default (the entry
  on kept ids, above), read back as `controller.id`)
  and its routed URLs carry it: `/stomp/<id>/html/<encoded>` where they were
  `/stomp/html/<encoded>`. `config.directory` is that address and the new
  `config.scope` the directory the host gave (`controller.directory` still
  means that); only the asset URLs (the inject bundles, the transport
  worker, the controller frame) are built from the scope. The same id passed
  again replaces, as before; a host that gives its own keeps one per tab
  (sessionStorage) and passes it back, so the tab's history entries,
  reloads and copied links keep resolving. A controller is a tab, not a
  browser: the cookie jar, the HTTP cache and the storage partitions are
  per scope and shared by its controllers, and sessionStorage is cleared
  once per scope per worker lifetime, where every new server cleared it
  before. A routed URL whose controller is gone (a closed tab, a stale
  link) is redirected to the newest live controller of the scope with the
  same codec; with none, the host's error page answers with kind
  `controller` (a new value of the request log's `kind`). A URL of the
  old shape (`/stomp/html/<encoded>`, a tab or bookmark from before this
  change) is redirected to the newest live controller too. The worker also
  answers the inject bundles and the transport worker under an address
  (`/stomp/<id>/injectDocument.js`, a redirect to the scope's file), so a
  request that reaches this worker under an address finds the file; a page
  served by a worker of the previous build stays blank until the version
  self-heal swaps the worker. A replaced controller's calls reject with
  "Controller replaced", and a request on a transport port whose other side
  is gone fails at once instead of waiting out the worker's timeout. A tab
  that crashes or is discarded fires neither `pagehide` nor a port close, so
  its entry lingers until the worker restarts: documents at its address get
  the orphan answer, its stale subresource links wait out the bounded
  timeout. The
  multi-controller suite covers it, including the first controller still
  navigating after the second registered.
- The transport can run off the host page's thread. `StompController` takes
  a `TransportDescriptor` (`{ module, options }`, what `RemoteController`
  already took) in place of a ProxyTransport instance and starts it in a
  dedicated Worker (`dist/transportWorker.js`, the `transportWorker` asset,
  served from the directory like the rest); the service worker and every
  proxied page reach the transport over ports the worker serves, and the
  WebSocket handshake cookies stay with the controller, which the worker asks
  for them. A proxied frame's synchronous XMLHttpRequest that needs the
  network now completes in same-origin mode (it spun the main thread for
  the 30 s limit while the transport shared it; measured: status 0 after
  30.0 s before, 200 after). `host: 'page'` on the descriptor keeps the
  import in the page, and an instance is served from the page as before.
  `controller.transportHost` says which (`worker` or `page`); when the worker
  cannot start or the module cannot be imported there, the page imports it
  instead and a `transporthost` event (`detail: { host: 'page', error }`)
  says so, never a dead controller. `setTransport()` takes a descriptor on a
  worker host (the swap is a message to the worker; in-flight requests finish
  on the old transport) and an instance on a page host, a TypeError
  otherwise. The controller frame hosts its worker the same way, so
  `RemoteController` gets it for free. The `transport-worker` suite covers
  the boot, the sync XHR, a swap from epoxy to libcurl, both fallbacks and a
  page WebSocket served from the worker.
  The demo and the example host pass a descriptor, so their proxied pages
  get the worker-hosted transport; the dev loop reloads the page when
  `transportWorker.js` rebuilds.
- `npm run dev` is a live-reload development loop: esbuild watch plus the
  demo server in one command, a `/__dev` WebSocket that reconnects forever,
  stylesheets swapped in place, inject rebuilds reloading the proxied frames,
  service worker rebuilds applied through `registration.update()` without a
  page reload (same-origin mode), server restarts and host-page bundles
  reloading the page, and an esbuild error overlay. Development only
  (`STOMP_DEV`).
- test: scramjet's adversarial corpus ported as a measurement (`adversarial-*`
  suites over `test/pages/adv-*.html`): 682 probes per mode across nine
  groups run inside a proxied page in both demo modes; 93 reach the host
  window, a proxy URL or a proxy fingerprint and are recorded, not fixed (see
  the parity doc's corpus row).
- test: a bounded set of web-platform-tests is vendored under `test/wpt/`
  (456 files, 3.4 MB, upstream `cbd1ca1e`: cookies, fetch/metadata and the
  referrer-policy top-level and attribute matrix, with testharness.js and a
  report script of ours) and run as the `wpt-cookies`, `wpt-fetch-metadata`
  and `wpt-referrer-policy` measurement suites: every page runs natively from
  the fixture and again in a proxied frame, and the verdicts are compared per
  subtest against `test/wpt/expected/<suite>.json` (a new proxied failure
  fails the suite, so does a listed failure that now passes;
  `UPDATE_EXPECTED=1` rewrites the list). `test/wpt-server.mjs` ports what the
  tests need from wptserve: `.sub.` substitutions over the fixture's two host
  names, `.headers` sidecars, `.any.html` wrappers and the python handlers.
  First measurement (subtests passing natively, then proxied): cookies 764
  to 306 of 942, fetch-metadata 517 to 255 of 855, referrer-policy 2418 to
  1315 of 2522; the causes are in the parity doc's WPT row. Nothing is fixed
  here.
- `examples/minimal-host.html` is the smallest host application (same-origin
  `StompController` on epoxy, one frame, the three callbacks), served by the
  demo at `/examples/`; README "Embedding" walks through it, and the new
  `host-api` suite runs the host API checklist against it.
- The demo has a request viewer: long-press Recents or Ctrl+Shift+X slides
  up a panel with the active tab's proxied requests (method, status, real
  URL, destination, time, size, a `cached` tag), built from the controller's
  `onRequest`; the HTTP cache is on in the demo and `?nocache` turns it off.
- `onRequest` on both controllers reports every proxied request (real URL,
  method, destination, status, time, cache hit, size, error) with the frame
  it belongs to, for request viewers; costs nothing when unset.
- `controller.cookies` lets the host read the Cookie header the proxy would
  send, import Set-Cookie values, export cookies as records and wipe an
  origin or everything; host-only by construction.
- An HTTP cache in the service worker, on by default (`cache: false` turns
  it off, `?nocache` in the demo): GET responses are kept in a Cache API
  store and served or revalidated with ETag / Last-Modified as Chrome's HTTP
  cache does (docs/http-cache.md), never `no-store`, capped at 5 MB per
  entry and 50 MB in all; `controller.clearCache()` drops it.
- Frames dispatch a `navigate` event (and controllers take `onNavigate`)
  whenever the proxied page loads, changes its URL through pushState /
  hashchange or changes its title, with whether its own history can step;
  the controller-frame poll is now a fallback (`pollInterval: 0` disables
  it).
- `frame.go()` and `frame.reload()` on both controllers resolve when the new
  document has reported (its URL, title and history state are in), a second
  after the frame's `load` event for a document that never reports (an
  image, a download, a blocked response), 30 seconds at the most; `reload()`
  resolves false when there was nothing to reload. The first report comes at
  document start, before the body is parsed: right for an address bar, too
  early for reading the page's DOM (use the frame's `load` event, listened
  for before `go()`). Both controllers also dispatch `navigate`
  (`detail: { info, frame }`), `open` (`detail: { url, frame }`) and
  `request` (`detail`: the `onRequest` report) as CustomEvents, so handlers
  can be added after construction.
- `onRequest` reports: a subresource fetched before its page has said which
  frame it is in (a head stylesheet or script) waits up to 1.5 s for that
  and carries its frame like the document does; a CSS image is reported
  without the `#url(...)` fragment the CSS rewriter keeps; `destination` is
  `fetch` for fetch, XHR and keepalive beacons (the browser's empty string).
  The document's own report lands after its body was served, often after
  the first fetches of the page.
- `StompController.register(directory?, { assets, updateViaCache })`
  registers the service worker served from the directory (the constructor's
  default when omitted) with `updateViaCache: 'none'` and resolves with the
  registration once its worker is activated, 30 seconds at the most (a worker
  stuck installing never hangs the host). The constructor's `serviceworker`
  accepts that registration (or any `ServiceWorkerRegistration`) in place of
  a worker: it takes the active, waiting or installing one and shakes hands
  once it is activated. The activation helper every host copied from the demo
  is gone from `examples/minimal-host.html`. Both controllers and both frame
  classes keep their state in `#fields`: nothing a page could reach is an own
  property any more (`lastHandshake` stays, the dev loop sets it).
  The demo boots through `register()` too.
- `errorPage` on both controllers: the host's own page for a document the
  proxy itself failed to produce (the transport could not reach the origin,
  the worker's timeout, a routing error, a blocked rule, the refusal to proxy
  its own origin). The worker fetches it from its own origin without the HTTP
  cache, puts `globalThis.stompError = { url, status, error, kind }` in its
  head (escaped so no message can close the script) and answers under the
  frame's routed URL with the failure's status (502 for a transport
  failure, which the request report counts as 0), never cached, so
  `location.reload()` retries the real page (the page is not an injected
  one: `frame.url` reads null for it, the request report names the URL).
  Upstream error pages (a site's own 404) are untouched. In origin-isolation
  mode the path is on the proxy host, where the worker runs. Request reports
  carry the same `kind` next to `error`. `examples/minimal-host.html` uses
  `examples/error.html`. The demo's is `demo/public/error.html`,
  and its request viewer shows a failed document under the tab that asked
  for it, with the failure's kind.
- `onOpen(url, frame)` on `StompController` and `RemoteController`: a proxied
  page's `window.open`, `target="_blank"` and named-target or modifier clicks
  become a callback to the host, which opens them in its own tab model; the
  page's `window.open` returns `null`, like a popup blocker. The request is
  posted through the top window's native `postMessage` captured before any
  page code ran, and the host accepts it only from its own frames on the
  proxy origin. Without `onOpen`, popups open natively as before. The demo
  opens them as switcher tabs.
- `Frame` gained `back()`, `forward()` and `reload()`. `back()` and
  `forward()` step the frame's own session history (Navigation API) and
  resolve to whether a step was possible; `canGoBack` / `canGoForward`
  report the same ahead of time.
- `npm test` runs the browser suites in `test/` (Playwright on the system
  Chrome): the demo end to end, Back and history walking, the tab switcher,
  origin isolation, frame-escape vectors in both modes, and runtime-inserted
  script rewriting. Each suite gets its own demo server and fixture on free
  ports; four run at once by default.
- The demo is a Powermouse-styled host application: landing page with quick
  links, tabs (one `Frame` each) with an address bar that tracks the real
  URL, a transport switch, and an early-Android style navigation bar with a
  tab manager. `demo/README.md` walks through how it uses the API.

### CI

- GitHub Actions workflow (lint, types, format, prose, build) on pushes and
  pull requests with a read-only token, pinned actions, install scripts
  disabled and no write-back; dependabot for actions and npm;
  `npm run check:prose` enforces the no-em-dash and no-AI-attribution rules.

### Deployment

- The demo is live at https://stomp.fracit.al: `.github/workflows/deploy.yml`
  builds every push to `master` and has terp run `deploy/terp-deploy-gate.sh`
  (stage build, swap, pm2 restart, health check, rollback). The demo server
  reads `PORT`, `STOMP_WISP_URL` and `STOMP_PROXY_ORIGIN` from the environment
  or a `.env` file and hands the page its settings through `/config.js`; with
  an external wisp URL the built-in `/wisp/` is not served. See
  `demo/README.md`, "Deploying somewhere real".
- The demo server reads `STOMP_HTTP3=0` (HTTP/3 for the epoxy transport
  off; it is on by default, see Demo and API) and `WISP_NO_UDP=1` (the
  built-in wisp refuses UDP streams, to see the fallback).
- The demo server's built-in `/wisp/` is holyWisp (the `holywisp` package)
  instead of `@mercuryworkshop/wisp-js`, so `npm run demo`, `npm run dev`
  and every test run relay through the same server as stomp.fracit.al's
  `wss://holywisp.fracit.al/`, set up like the edges (flood protection off,
  messages of at most 256 KiB, a 64 MiB stream queue, UDP for HTTP/3).
  `WISP_ALLOW_LOOPBACK` and `WISP_NO_UDP` work as before. holyWisp runs as a
  child process on a free loopback port and never outlives the demo server
  (exit, SIGINT, SIGTERM, SIGHUP, and a SIGKILL or crash through its stdin
  pipe); `HOLYWISP_BIN` runs another build of it, `STOMP_WISP_URL` starts
  none.
- The package is `@sysce/stomp` on npm (it was `stomp-rewrite`, installed
  from this repository's `dist` branch, which is gone).
  `.github/workflows/nightly.yml` publishes master every night as
  `@sysce/stomp@nightly`, version `<package.json version>-nightly.<UTC
yyyymmddhhmm>.g<commit>`, only once CI passed on that commit and only when
  the commit is not published yet, through npm trusted publishing (no token
  stored) with provenance. Import from `@sysce/stomp` and
  `@sysce/stomp/path`.

### Dependencies

- meriyah 7, parse5 8, css-tree 3, entities 9, idb 8, set-cookie-parser 3,
  crypto-js 4.2.
- `effective-domain-name-parser` is replaced by `tldts`; `sameHost` now
  compares registrable domains rather than second-level labels.
- `meriyah-loose` (a 4.x fork) is dropped; scripts that fail to parse are
  rewritten to `throw new SyntaxError(...)` as before.

### Fixes

- A frame fires `load` once per document, as natively. The shell writes
  the page from a timer, and when Chrome ran the shell's load task first
  the frame element fired `load` for the shell, with the inject's script
  as its document, and again for the page: a page that read its frame at
  the first one read STomp's shell (seen in the http-cache suite's
  reloaded frames on CI). The embedding document's inject now keeps a
  frame's load event from the page while the frame's document is still
  the shell. The http-cache suite counts each frame's load events, natively
  and through both modes.
- The worker's HTTP cache keeps what Chrome's keeps and asks the origin
  when Chrome's does (docs/http-cache.md has the table, measured in 152
  and 156). It kept only a response with explicit freshness to a request
  without credentials, so the origin of a `no-cache` page or script with
  an ETag was sent no conditional request and sent the body again each
  time, a response with only a Last-Modified was fetched every time, and
  a fresh `must-revalidate`, `private` or cookie-bearing one was too. Now
  a `no-cache` or stale response with a validator is kept and confirmed
  with a 304; freshness is Chrome's (max-age, Expires, a tenth of the age
  by Last-Modified, the Age it arrived with; s-maxage is not a browser's
  and a `no-cache` Pragma is heeded); `Vary: *` and a Vary mismatch
  revalidate with the entry's validator; the request's cache mode is
  honoured (`no-store`, `reload`, `no-cache`, `force-cache`,
  `only-if-cached`, a page's own conditional or Cache-Control header, a
  reloaded document); `Clear-Site-Data: "cache"` drops the origin's
  entries; a cookie a 304 sets is set (it was dropped); a HEAD the cache
  answers has no body (it carried the GET's), and a range of a kept 200 is
  a 206 of those bytes (the whole entry was given); a response with
  neither a validator nor time to live is kept for `force-cache`; a 206 is
  kept as a part of the resource, and a later request is given the bytes
  it holds once the origin confirms them, with the rest asked for by range
  (`If-Range`), as Chrome completes a sparse entry; a stale entry no longer
  answers for a 5xx or a failed request within `stale-if-error`: the page
  gets the error, as in Chrome. An entry made for
  a request with credentials is confirmed with the origin before a
  request with other credentials is given it, where Chrome hands it over.
  A reload of the host's tab reaches the page the host shows again: the
  controller tells the worker how the host page was loaded
  (`src/controller/hostReload.ts`), and the navigations that follow within
  ten seconds revalidate the document after a reload and fetch it and what
  it loads past the caches after a hard reload (Ctrl+Shift+R), where the
  worker's caches answered either. A request log entry has `revalidated`
  set for a response the origin confirmed with a 304 (the demo's viewer
  tags it "304"). (http-cache suite, native against proxied in both
  modes; cache, sop-escapes and sop-partitions suites.)
- A frame's Back and Forward pass over the entries Chrome's history
  intervention passes over: those of a page that sent the frame on to a
  new document by script with no user activation, its own or one carried
  over from a document of its origin that navigated to it (a link, not a
  typed URL, Back or Reload). Back to such a page landed on it and it
  redirected again; Back is now off when every entry before is one of
  those, as Chrome's is. Measured in Chrome 152 and 156: a pushState or
  fragment without activation is kept, as is a frame in the page that
  redirects, and a page's same-document entries go with it. Proxied
  documents tell the host when they first get an activation, since the
  browser carries one over between every two of them (they share the
  proxy's origin). (toolbar-history suite.)
- A frame's Back and Forward (`back()`, `forward()`, `canGoBack`,
  `canGoForward`, and the demo's buttons) go where a browser tab's go.
  After a link to another site Back was greyed out for good: the controller
  read the page's own Navigation API, which shows a document only its own
  origin's entries. A frame in the page that navigated was skipped where
  Chrome's Back steps it first. And every tab of the demo is a frame of one
  page, so they share one session history: once another tab had moved,
  Back or Forward did nothing (the browser refuses a sandboxed frame a
  traversal that changes a sibling) or had nowhere to go (a new entry in
  any tab drops the forward entries of all of them). Each frame now keeps
  its own history, its nested frames' steps included, read with the host's
  own Navigation API; a step is the browser's traversal where that touches
  nothing outside the frame, and a `location.replace` to the step's URL
  where it would. (toolbar-history suite.)
- A page that sends itself elsewhere with `location.href` or `assign()`
  before its load event replaces its entry, as natively. Through the proxy
  about one such redirect in three made a new entry, so Back went to the
  redirecting page and it redirected again. (toolbar-history suite.)
- The load gate under a list's `$csp=`: a policy the blocker carries that
  refuses a worker from a `blob:` URL (`worker-src 'none'`,
  `child-src 'none'`, a `script-src` without `blob:`) refused the worker
  the inject makes a sealed copy's URL in, and an image of another site
  in an about:blank frame of such a page got a live `blob:` URL any realm
  of the proxy origin could read. The carried policy names the service
  worker's route of that worker's script among its worker sources (its
  full URL, so nothing else is let in), and a worker refused before it
  answered is made again from the route. A page's own policy, a sandbox
  and the proxy's script policy for a frame without allow-scripts refused
  nothing of the inject's (measured, plain Chrome 152 and 156 and through
  the proxy). (sop-escapes `csp/` cases.)
- The load gate after a service worker restart: the worker takes a
  client's channel at once only when it served the client's document, and
  otherwise only the one that answers a nonce it sends that client, which
  the inject hears before any listener of the page's. It took the first
  channel a client offered, and the inject opened its channel again with
  the page's own getters of a channel's ports: a page that redefined
  `MessageChannel.prototype.port2` was handed the channel and read
  another site's text through it, and the inject's copies stopped loading.
  A channel the page offers, a guess and a second answer are refused, and
  a revive the page dispatches itself is not heard. (load-grants and
  load-grants-restart suites.)
- CSS the page writes through the CSSOM in a document no service worker
  controls (an about:blank frame or popup it builds) loads: a rule put into
  a `<style>`'s, a `<link>`'s or an imported sheet (`insertRule`, `addRule`),
  a rule's declarations changed in place (`rule.style`, `rule.styleMap`,
  an `@font-face`'s source, a keyframe's), a rule put inside another, a
  constructed sheet changed after it was adopted, and a `<style>` given its
  text once it is connected asked the proxy origin's own server for their
  routes and never showed. Their loads are copied like the rest, once for
  the writes of a task. Elements, text nodes and styles of the page's own
  document moved into such a document were not seen at all (the insertion
  hooks told a node by its realm): their styles load too. Five writes
  loaded from the site itself, past the proxy, in any document: the
  declarations `addRule` takes, a rule put inside an `@media`, an
  `@supports` or a style rule, a keyframe given to
  `CSSKeyframesRule.appendRule`, a style attribute node set with
  `setAttributeNodeNS` or `attributes.setNamedItem`, and a URL named as a
  string of `image-set()` in a property write. All are routed (blank-sources
  suite: 56 loads the page makes natively in each of four documents, each
  through the worker and read back as written).
- The load gate: a load the proxy copies for a document no service worker
  controls (an about:blank frame or popup the page builds) is granted by
  what the inject announced for it on a MessagePort its bundle opened to
  the worker before the page ran, under a single-use token, where the
  worker trusted a header that named the load. The old header value, a
  made-up token, a token sent again and one sent twice at once are the
  page's own requests, refused by CORS as natively. The copy of another
  site's image is given a `blob:` URL that nothing can fetch (made in a
  worker that is then terminated; the renderer's memory cache still shows
  it), a script's or stylesheet's is revoked as its load starts, and what
  a granted copy hands over goes through opaque response blocking first
  (a video's or sound's only when it is media by its first bytes). Read by
  the browser's own `fetch`, thirteen ways gave another site's bytes; one
  is left and listed, a playing video's or
  sound's URL, with the measurement that shows why
  (docs/same-origin-policy.md). A srcdoc frame under an about:blank frame
  or popup, which has no service worker either, has its loads copied: they
  failed. No measurable cost: an about:blank frame with fifty images of
  another site loads in 48 ms as before, 6 KB of heap a frame. (sop-escapes
  `gate/` cases, load-grants, load-grants-restart and document-kinds
  suites.)
- `:visited` is partitioned as Chrome partitions it (since Chrome 136: by
  the link's URL, the top-level site and the frame's origin), where every
  proxied link was one partition's: a link visited on one site read
  visited on every other, which is what the partition is there to stop.
  A link's routed URL is now a link route,
  `<scope>~/<codec(context + ' ' + url)>#fragment`, where the context is
  the origin of the document that holds the link and, when it is another
  site's frame, its top-level site; it names no controller, so a link reads
  the same in every tab and after a restart. The service worker answers a
  link route with a redirect to the document's address, which is unchanged
  (as is everything a page, the rewrite cache or a host reads), and the
  browser's own history, which records every URL of a redirect chain, keeps
  the link route. Link clicks, `location.href` and `assign`, GET forms,
  `pushState`, fragment navigations, redirect chains and Chrome's
  self-links (a visit from a site's own origin counts for the visited
  URL's site too) read as natively in every context the suite looks at;
  the redirects that are the worker's own are taken off the page's
  navigation timing. `controller.route()` is as before and
  `controller.unroute()` reads a link route back as well. Not recorded,
  and so unvisited where Chrome shows them visited: what replaces a
  frame's history entry (`location.replace`, `replaceState`, a navigation
  before the load event, a meta refresh), a tab the host opens, a frame's
  `src` its page sets, and the navigations of a page that listens to the
  Navigation API. Cost: a page of 5000 links takes 182 ms from response to
  DOMContentLoaded where it took 175 (medians of alternated runs), and a
  frame about 8 KB more heap (frame-cost: 1139 KB a frame, 1130 before).
  (visited suite, docs/same-origin-policy.md "Visited links".)
- `navigation.activation.from` is null for a document that was reached
  from another origin's, as natively: it was the entry of the page that
  linked to it, with its whole URL. (visited suite.)
- A document's navigation timing counts the site's own redirects: a GET
  form's document showed one redirect (the worker's, from the form's
  route) where Chrome shows none. (visited suite.)
- The rewriter's output is fuzzed for the whole class. A payload that
  reads `top` and `location` in code of its own (a function, an arrow, a
  getter, a tagged template) is put into every expression slot of every
  node kind the parser produces, alone and one template inside another;
  what the rewriter prints must parse, hold the payload and read neither
  name but through the access API (rewriter-unit: every slot, and 6000
  seeded pairs), and the payloads, evaluated in a proxied page, must see
  the page's own top and location (adversarial-fuzz suite, both modes,
  seeded and bounded in time). rewriter-unit also fails when the parser
  has a node field that no template reaches and no exemption names.
- Four shapes the rewriter printed as code that does not parse, which
  lost the whole script, are printed with the parentheses they need:
  a member of a call's value written to when the call is rewritten in its
  lazy form (`o[k].find(x.y).value = 1`, a tag or a `new` of such a
  call), `export default (function () {})()`, a class that extends
  an expression in parentheses (`class A extends (await f()) {}`), and a
  destructuring assignment that is or becomes an argument after an array
  or object literal (`f({ a: 1 }, ([b] = c))`,
  `({ a: 1 })[k] ||= ([b] = c)`), which Chrome refuses without them.
  Around what a class extends and a call's own argument only the
  parentheses the page wrote are put back, so `class A extends B++ {}` and
  `f({ a: 1 }, [b] = c)` stay scripts V8 refuses. Over the early-error
  texts (`rust/host/early.mjs --narrow`) the JavaScript rewriter now prints
  5 scripts V8 takes into ones it refuses, where it printed 19, and the
  `early-errors` suite names none of these as known any more.
  (rewriter-unit, adversarial-eval and early-errors suites.)
- `f().postMessage.call(w, m)` still calls `f`. The `.call`, `.apply` and
  `Reflect.apply` forms of a post dropped the expression the method was
  read from, so what it did (a call, a throw for a member of null) did
  not happen; it is evaluated first, as written. An `.apply` or
  `Reflect.apply` with more arguments than it takes is left as written,
  where the extra ones were dropped. (rewriter-unit suite.)
- `super.top`, `super[k]`, `super.eval(code)` and `super.location = url`
  go through the access API. `super` reads the home object's prototype
  with `this` as the receiver, so an object whose prototype is the
  window, with a method called on the window, read the real top-level
  window and called the real `eval`, which ran its code unrewritten.
  (rewriter-unit and adversarial-eval suites, both modes.)
- A pattern's reads go through the access API wherever the pattern
  stands. Only an object pattern at the top of a declaration, an
  assignment or a parameter was wrapped; one inside an array pattern
  (`const [{ top: t }] = [window]`), under a computed key, in a rest
  element, in a `for ... of` head, a `catch` clause, a rest parameter, an
  array parameter or a parameter that a later parameter's default reads
  was left as written and read the real top-level window. A member that
  is a pattern's target with a key known only when it runs
  (`[window[k]] = [url]`) is written through the access API too, like
  `window[k] = url`: it navigated the frame as the page wrote it.
  (rewriter-unit and adversarial-eval suites, both modes.)
- A member key that is an object is converted once, before the access API
  looks at it. `window[{ toString: () => 'top' }]` was no name the
  helpers knew and read the real top-level window, and the same key
  wrote `location` as the page wrote it.
  (adversarial-eval suite, both modes.)
- A loop the rewriter replaces twice has its source rewritten. A classic
  script's `for (var location of source)` outside any function is
  replaced for its head, and again when the source is one the access API
  iterates (`top.list`, `o[k]`); the second replacement took the first's
  nodes for its own and the source was printed as the page wrote it, so a
  `top` there was the real top-level window. What a replacement hands
  back to the walk stays the walk's, whichever replacement made it.
  (rewriter-unit and adversarial-eval suites, both modes.)
- A large script split across the rewrite workers routes its
  `var location = url` as the whole would. A program split into runs of
  its own statements has each run rewritten inside a function, where
  `var location` declares a local and is left as written; outside any
  function it assigns the window's location, so the stitched script
  navigated the frame to the URL as written, past the proxy. A program
  that declares `location` with `var` outside its functions is rewritten
  whole. A group of modules that comes back from a worker as it went (the
  rewriter's fallback for text it cannot parse) is refused too, as a run
  of statements already was. (rewriter-unit suite.)
- A statement that is a string in parentheses stays an expression.
  `('use strict'); x = 1` is a sloppy script (the string is no directive),
  and the rewriter printed it as `"use strict";x = 1`: the script, the
  function or the evaluated text it began turned strict, where an
  assignment to an undeclared name throws, `this` is undefined in a
  called function and `arguments` stops following the parameters. The
  statement keeps its parentheses. A directive written with an escape
  (`'use\x20strict'`, which is not "use strict") is printed as written
  for the same reason: its value was printed, which is.
  (rewriter-unit and adversarial-eval suites, both modes.)
- `super.postMessage.call(this, m)`, `.apply` and
  `Reflect.apply(super.postMessage, this, [m])` stay the class's own
  calls, like `super.postMessage(m)`. They were handed to the access API
  as a post to `this`, which called the object's own `postMessage`: the
  subclass's override where the page asked for its parent's.
  (rewriter-unit and adversarial-eval suites, both modes.)
- A computed key is rewritten like any other expression. An identifier in
  one was taken for a name the rewriter leaves alone, so
  `{ [location]: 1 }`, a class member `[location]() {}`, a pattern's
  `{ [location]: a }`, `delete o[location]`, `[o[location]] = a` and
  `super[location]` named the key with the real location's string, which
  showed the page the proxy's URL. What a class extends
  (`class A extends top {}`) is rewritten too. (rewriter-unit and
  adversarial-eval suites, both modes.)
- The code inside what the rewriter replaces is rewritten in three more
  places: the value assigned to a bare `location`, `top` or `eval`
  (`location = f(() => top)`, and the compound forms), a dynamic
  `import()`'s specifier and options, and the pattern of a declaration
  whose source is wrapped (its computed keys and defaults:
  `const { [k()]: a, top: t = v() } = o`, a destructured parameter's too).
  Each was printed as the page wrote it, so a `top` there was the real
  top-level window, a function there ran unrewritten and an `eval(...)`
  there was not a direct eval. (rewriter-unit and adversarial-eval suites,
  both modes.)
- A page that assigns `eval` the `eval` it read keeps its direct eval. A
  read of `eval` answers the proxy's stand-in, and `eval = saved`,
  `window.eval = saved` or a pattern that writes `eval`
  (`[eval] = [saved]`, `({ eval } = o)`, `for (eval of a)`) stored that
  stand-in under the name: every `eval(code)` after it was a call of a
  function, which runs the code in the global scope, so it no longer saw
  its caller's variables. The write stores the eval itself; a pattern's
  `eval` is the reference `$s$j.ref1(eval, set, 'eval')`, as its
  `location` is. (rewriter-unit and adversarial-eval suites, both modes.)
- Under `rewriter: 'wasm'` the module rewrites each of these as the
  JavaScript rewriter now does. It put no parentheses around a lazy member
  call with a member, a tag or a call on it, dropped the expression a
  post's `.call`, `.apply` or `Reflect.apply` read its method from (and
  took an `.apply` with more arguments for a post), left `super`'s members,
  a computed key that is a name and what a class extends as written,
  printed the value of a write to a bare `location`, `top` or `eval`,
  `import()`'s specifier and options and the pattern of a declaration
  whose source it wrapped as the page wrote them, left an `eval` a pattern
  writes as written, and wrapped a pattern's
  source only for an object pattern at the top of a declaration, an
  assignment or a parameter. The rest it never had: it keeps the page's
  text, so its parentheses and its directives stay, and its walk of a loop
  keeps the loop's source. `rust/host/cases.mjs` has a family for each
  hole, which the new `rewriter-parity` suite compares between the two
  backends with the module the build ships (814 cases, no difference); the
  module's revision is 4, so a kept rewrite of an older one is not served.
- Resource timing tells every way the worker answered a load apart, as
  Chrome does (measured in 152 and 156): the body and 300 bytes from the
  network; 0 and `deliveryType` "cache" from a cache, with the protocol
  when it is the renderer's memory cache and without when it is the HTTP
  cache; 300 after a 304 (it read as a network load). A script answered
  with the rewrite cache's kept response reads as the load it was: the
  response is the same for every load (Chrome keeps the compiled code
  with it), so the worker notes how each was delivered and tells the
  window, where every such load read as a network load delivered by
  "cache-storage", also one the worker's caches answered. (sop-escapes
  and rewrite-cache suites.)
- A direct `eval`'s arguments are rewritten. They were left as written in
  both branches of its replacement (`eval(top.x)` became
  `$s$j.isEval(eval) ? eval($s$j.evalScope(top.x)) : eval(top.x)`), so an
  argument that named `top` or `location`, or read a member, reached the
  real one: `eval(top)` handed a page the real top-level window.
  (rewriter-unit and adversarial-eval suites.)
- `super.postMessage(m)` in a class stays the class's own call: it was
  rewritten to a call that names `super` as a value, which does not parse,
  so the whole script failed. (rewriter-unit suite.)
- An inline script of a document's markup that the rewriter changes nothing
  in, written as the rewriter prints it (`<script>f();</script>`), is named
  for the page like every other: its stack frames and uncaught errors read
  `<anonymous>` where the page's URL stands natively, because a script
  whose text was its own rewrite was taken for one already rewritten and
  skipped when the markup's scripts were named. (error-surfaces suite.)
- Cross-origin isolation: a proxied page that sends COOP `same-origin` and
  a Cross-Origin-Embedder-Policy (or a Document-Isolation-Policy) is
  cross-origin isolated as natively (`crossOriginIsolated`, the
  SharedArrayBuffer global, a SharedArrayBuffer shared with its workers,
  the 5 microsecond clock) when the host's own page is, which the host
  decides by sending those two headers on its page (and an embedder policy
  on the files of `dist/`, README.md "Cross-origin isolation"); there is no
  option. Every other page, its frames the permission does not reach and
  its shared workers have what a page without isolation has, and a COEP's
  own effects are the page's: a frame or dedicated worker without the
  policy does not load, `require-corp` refuses a no-cors load of another
  origin without a Cross-Origin-Resource-Policy, `credentialless` sends it
  without cookies. A host that sends nothing is as before: no page is
  isolated. An isolated host whose proxy is on another origin has no real
  popups (Chrome hands a frame of another origin no window once the
  top-level page sends COOP `same-origin`), so it should take them with
  `onOpen`. docs/same-origin-policy.md, "Cross-origin isolation", has the
  measurements and what is left. (cross-origin-isolation and sop-escapes
  suites.)
- A frame whose navigation the proxy refused reads as one that failed to
  load natively: `contentDocument` is null and `contentWindow.location.href`
  throws the page's SecurityError, where the hook threw one naming the
  proxy's origin.
- Opaque response blocking: a classic script of another origin whose
  response is HTML, XML or JSON by its type and first bytes (Chrome's rules:
  the never-sniffed types, `nosniff`, the JSON prefixes sites put before
  their data) is not handed to the page, and the element fires `error` as
  natively, where it fired `load` after failing to parse. (sop-escapes
  suite.)
- A video or sound behind a redirect loads: Chrome's media loader gives up
  on a load over 64 KiB whose redirect a service worker answered with
  `Content-Length: 0` (measured with a plain worker), so a redirect goes out
  without its Content-Length, which no page can read. (sop-escapes suite.)
- What leaves a canvas or a media element as a stream or as sound follows
  the same-origin policy: `captureStream()` of a tainted canvas or of an
  element playing another origin's data is the browser's SecurityError, a
  stream captured earlier ends when its source turns (its clones too), and
  Web Audio hears silence from a MediaElementAudioSourceNode of such an
  element, through `connect` however it was obtained, as the element
  changes source. A video or sound the page's own URL redirects to another
  site is that site's while it is still loading too: the worker records the
  chain and the inject asks it over the synchronous bridge the first time
  an element with data is judged (its resource timing entry, which carries
  the mark for an image, is not there until the last byte). Cost: about
  15 KB of heap a frame for the hooked stream and audio interfaces (the
  frame-cost suite measures 1065 KB a frame, 1050 before). (sop-escapes
  suite.)
- The rules of a stylesheet of another origin cannot be read or changed:
  `cssRules`, `rules`, `insertRule`, `deleteRule`, `addRule` and
  `removeRule` throw the browser's SecurityError for a sheet of another
  site not loaded with CORS, one the page's own URL redirects to, and one
  another site redirects back, and for an `@import`ed sheet by its own URL.
  Every proxied sheet is same-origin to the browser, so a page read another
  site's rules. (sop-escapes suite.)
- An XMLHttpRequest with a listener on its upload object is preflighted, as
  natively (in pages and in workers), and the preflight cache is kept per
  top-level site and frame site. (sop-escapes and sop-partitions suites.)
- An about:srcdoc document that sends no referrer is judged as the document
  that made it, as natively: a CORS answer naming that origin is accepted
  and its credentialed requests carry its cookies. Its nearest routed
  ancestor vouches for it to the worker when its client starts (a sandboxed
  one without `allow-same-origin`, or one under a frame of an opaque
  origin, stays opaque). (sop-escapes suite.)
- A canvas is tainted by what the image, video or bitmap it draws came
  through, and by what any document drew into it: an image of the page's
  own URL that redirects to another site (also one that comes back, one
  drawn while it loads, and whatever the page does to its resource timing
  buffer), a canvas a frame or popup of the page tainted and the page reads
  with its own realm's methods, and the copy of such a load a document no
  worker controls gets. A tainted ImageBitmap cannot be sent anywhere
  (`postMessage` to a window, worker, port or channel, `structuredClone`, a
  history state: DataCloneError), and `new VideoFrame()` of a tainting
  source is refused, as natively. (sop-escapes suite.)
- A no-cors response that went through another origin and came back is
  opaque to `fetch`, as natively; it was `basic` and readable. (sop-escapes
  suite.)
- Resource timing: a `fetch` or XMLHttpRequest of another origin whose
  Timing-Allow-Origin names the page shows its timing (the worker's mark
  rides in Server-Timing, which the inject takes out of the headers the
  page reads, and a Server-Timing the page may not read as a header is
  timing only), an XMLHttpRequest's entry says `xmlhttprequest`, and every
  entry the page may read has a `transferSize` (its body and 300 bytes, 0
  for an answer from the worker's caches), a `deliveryType` and a
  `nextHopProtocol` (the scheme's usual one: no transport reports what the
  origin spoke). (sop-escapes suite.)
- A proxied WebSocket that cannot connect fires `close` right after `error`,
  in the same task, as natively: Chrome fires both before a task queued from
  the error listener runs. The close came from a timer, so such a task ran
  between the two (the `adblock` suite compares the sequence with the
  browser's own).
- A stylesheet is rewritten the same whatever was rewritten before it, and
  its rewrite always ends. css-tree keeps its token buffer between parses
  and reads one entry of it that the parse at hand never writes (the token
  at index `source.length`, when a sheet's outermost block closes): with an
  opening bracket left there by a longer sheet, a closing bracket with
  nothing open (`a{} } b{}`) was matched against it, the same sheet parsed
  differently from one load to the next, and for some sheets the parser's
  recovery went round forever, making nodes until the heap was gone (a
  sheet of 32 characters after an ordinary one, in the service worker and
  in the page). The buffer is cleared after every parse (css-parse-history
  suite; found by a fuzz of mutated sheets, 400,000 of which now run
  clean).
- A proxied site's documents no longer get a resource another site loaded
  from the renderer's memory cache: natively each site has a renderer of its
  own, through the proxy every site shares one, so an image, script,
  stylesheet, font or text track another site's page loaded was handed to
  this one without a request. The worker now hands the browser those as
  `no-cache` without validators, so it asks again for each document, and
  answers from a memory cache of its own per site of the document (and
  credentials mode): a same-site document's fresh resource comes from
  memory, as natively, with the `cache` option on or off.
  (sop-partitions suite.) Cost, alternated runs of the build before and
  this one (4 each, median ms to the main content, cold / warm / revisit):
  YouTube home 3979/1635/2250 before, 3661/1595/2259 now; CNN
  6089/3480/3624, 6019/3393/3475; Discord 6075/4597/5314, 6458/4752/5115;
  Google 759/334, 633/314 (its revisit pass does not finish in the probe
  for either build): none past the noise of the runs.
- A page that takes `WebGLRenderingContext.prototype.texImage2D` (or
  `texSubImage2D`, or WebGL 2's) before any WebGL context exists gets the
  taint-checked method, as natively it gets one that refuses another site's
  image: it got the unhooked native since the hooks moved to the first
  context. The two interfaces stay unnamed until the page names them (a
  frame that never does pays nothing: frame-cost reads the same heap), and
  read as the data properties they natively are. (sop-escapes suite.)
- A page reached from the demo's address bar has focus, as a page a browser
  navigates to does: `document.hasFocus()` read false and the keys typed
  next went to the address bar (browserleaks' JavaScript page). The demo
  moves focus into the tab's frame when it navigates, and a `RemoteFrame`
  that has focus keeps it when its first proxied document commits: Chrome
  drops a focused frame's focus when its document moves to another process
  (the host origin's about:blank to the proxy origin), so the frame takes
  it back as soon as its document turns cross-origin. The demo's own keys
  (Ctrl+Shift+X, Escape, Alt+Left and Alt+Right) still work while a page
  has focus: a host hook in every proxied document hands them to the demo.
  A document sandboxed without allow-scripts runs no host hook (its policy
  refused the evaluation, and the hook reported that as an error).
  (focus and request-viewer suites.)
- Permissions are per proxied site. The browser keeps one permission for
  the proxy origin, which every proxied site is, so the service worker keeps
  each site's own state (by the real origin of the proxied top, as Chrome
  delegates a frame's permission) and the page reads it as natively:
  `permissions.query` (a real `PermissionStatus`), `Notification.permission`,
  `prompt` for a site that has not decided. A request (geolocation,
  `getUserMedia`, `Notification.requestPermission`) reaches the browser only
  for a site granted before, or when neither the site nor the browser has
  decided and the browser's own prompt asks; when the browser already holds
  the permission for another site, the host asks the user through the new
  `onPermissionRequest` (StompController and RemoteController), and without
  one the request is dismissed. One site's grant never reaches another. A
  page's Permissions-Policy and a frame's `allow` attribute are simulated: a
  frame of another site gets a powerful feature only when its `allow` names
  it. Before, the host's frame had no `allow` list and isolation mode denied
  every proxied page at once (browserleaks' geolocation page). The demo's
  frames carry an `allow` list and it shows its own prompt.
  docs/permissions.md has the trade-off; permissions suite.
- `getUserMedia` looks for the device first, as Chrome does: with no
  microphone or no camera a request ends in "NotFoundError: Requested device
  not found" for a site that may ask, a site that was denied and a frame its
  permissions policy refuses alike, and nobody is asked (measured on Chrome
  152 and 156: the devices come before the policy and the permission).
  Before, a frame of another site without `allow` and a denied site read
  NotAllowedError on a machine without the device, and a site whose answer
  the host had to ask for showed the host's prompt for a device that was not
  there. The permissions suite asks for the microphone, the camera and both
  on the machine's devices and in a Chrome with both, with no camera and
  with no microphone (the CI runner has neither, which is how it showed).
- A proxied site reads its own devices, as natively. Every proxied site is
  the proxy origin to the browser, so once any site was granted the
  microphone or the camera every other proxied page read the whole device
  list with its labels and the same `deviceId`s (an identifier across
  sites), one site's id opened the device for another, and `devicechange`
  reached sites that had never asked. Now `enumerateDevices()` shows a site
  what Chrome shows an origin: one nameless entry per kind until the site
  itself may use the microphone (audio inputs and outputs) or the camera,
  in a frame under its `allow`; `deviceId`s made for the page's own origin
  (stable for it, the same in a frame of another site, shared with no
  other origin, forgotten when the host clears the origin's cookies) and
  `groupId`s made for the document. The ids are turned back in
  `getUserMedia`, `applyConstraints`, `setSinkId` and `new AudioContext({
sinkId })` and made in a track's settings, capabilities and constraints
  and in `sinkId`; another site's id, or the browser's own, names no device
  (OverconstrainedError, NotFoundError). `setSinkId` follows Chrome where a
  site has no microphone permission (SecurityError for an element, no
  device for an AudioContext) and in a frame of another origin
  ("Permissions-Policy disallows speaker selection.", unless Chrome 156's
  `speaker-selection` is in its `allow`; the demo's frames name it), and
  `devicechange` fires only where the site may read what changed.
  docs/permissions.md has the measurements; permissions suite.
- `getUserMedia` answers in Chrome's order all the way: malformed
  constraints (TypeError), then for audio and then for video a missing
  device (NotFoundError) or constraints no device satisfies
  (OverconstrainedError, with Chrome's `constraint`), then the permissions
  policy, then the permission (measured on Chrome 152 and 156). The first
  three are the browser's own answer, which the controller gets from a frame
  of its document whose `allow` turns the camera and the microphone off:
  Chrome stops at its policy there, so nothing is prompted for and no device
  opens. Before, a frame its policy refused and a denied site read
  NotAllowedError for a request Chrome ends in TypeError or
  OverconstrainedError, a site the host had to ask for showed the host's
  prompt for constraints that could only fail, and after a refused request
  for both kinds `permissions.query()` could still read `prompt` for one of
  them for a moment. permissions suite: every request as a site that has not
  asked, a refused one, a granted one and a frame its policy refuses, with
  both devices, no camera and no microphone.
- `getUserMedia` reads the kinds a request asks for as Chrome does: a
  member that is `null` or any object asks for its kind (`{ audio: null }`
  opens the microphone natively), constraints may be a function or
  `document.all`, and `audio` and `video` are read once. Before, such a
  request reached the browser's call unasked, and a site that was refused
  got the device the browser lets the proxy origin use. The controller's
  verdict is asked only where it is needed: a site that holds the
  permission, or that nobody has decided about, goes straight to the
  browser's call; a page whose host's `Permissions-Policy` or a frame above
  refuses every kind it asks for is refused by the browser itself, with its
  console line in the page's own console, as natively; and a kind with no
  constraints on it needs only the device list. The verdict frame answers at
  once under a host's own Content-Security-Policy (`frame-src`, `child-src`,
  `default-src`, `sandbox`), Permissions-Policy and embedder policy
  (measured on Chrome 152 and 156), and a host sandboxed out of its origin
  gets no verdict instead of a wait. permissions suite: those kinds as a
  refused and a granted site, the verdict in a document under each header,
  and the demo behind a server that adds a Content-Security-Policy, a
  sandbox or a Permissions-Policy to every document.
- Client hints follow Chrome per proxied origin. A top-level page's
  `Accept-CH` is kept for its real origin (not the proxy's, which every
  proxied site shares) and applies at once to its own subresources and to
  the next visit; a `Critical-CH` hint it lacked makes the worker send the
  navigation once more; another site gets the high-entropy hints only as the
  page's `Permissions-Policy` (`ch-*`), an iframe's `allow` or a
  `delegate-ch` meta delegates them, and an `Accept-CH` meta counts for its
  own document. The values are the browser's (userAgentData, device memory,
  network estimate, pixel ratio, media preferences, the requesting
  document's viewport; `sec-ch-ua` and its two companions as the browser
  sent them, none when its user-agent override sends none), and a
  subresource's fields come in the order of
  Blink's header map, where the hints a site asks for sit among the
  defaults. Before, a site that asked for hints got only the three the
  browser adds by default (browserleaks' client-hints page showed "not
  received"). docs/client-hints.md; client-hints and client-hints-unit
  suites.
- A site framed by a frame of another site under its own top-level page
  (B in A in B) gets storage of its own and its own Partitioned cookies, as
  Chrome keys it (the ancestor chain bit); it shared them with that page.
  A framed document that redirects stays a nested one in its partition: the
  redirect made it a top-level document. A blob: or `javascript:` document
  a page makes is in the page's partition for its requests' Partitioned
  cookies (they were the site's first-party ones), and its document.cookie
  reads "" and ignores writes, as Chrome has it for a document whose URL
  is not http(s). The HTTP cache (`cache` option) keeps an entry per
  top-level site and frame site, as Chrome's network isolation key: a
  resource another site's page loaded was answered from the cache.
  (sop-partitions suite.)
- The browser keeps the compiled code of the scripts a proxied page loads,
  as it does natively (V8's code cache). Chrome keeps it for a script a
  service worker answers only when the response is a Cache API entry kept
  under the very URL the page asked for; a rewritten script was a response
  the worker made, so every visit parsed and compiled every script again
  (Google's bundles: about 50 ms of main-thread compile on a native
  returning visit, about 580 ms proxied). The rewrite cache now keeps a
  script the page loads under its routed URL, as the response it was given,
  and answers the next load with the store's own response when the origin
  (or the HTTP cache) sent the same bytes and the same headers again; the
  same document asking twice (its preload scanner, then its parser) gets
  the entry both times. With a controller id that stays (the kept one,
  above) the URL repeats across visits: the second visit is answered from
  the store and Chrome makes the code cache, the third consumes it.
  Measured on a 4.9 MB script (eight copies of three.js, 10.8 MB
  rewritten) in a persistent profile, the browser restarted for each
  visit, 3 runs alternated with a control that mints a new id per visit,
  medians: from the store without compiled code the script is ready in
  548 ms (77 ms parsing off the main thread, 188 ms evaluating, which
  compiles its functions as they run); with the code cache consumed
  (2.2 MB, `consumedCacheSize` in the trace's `v8.compile`) in 319 ms
  (5 ms deserializing, 18 ms evaluating); with a new id per visit, as the
  demo had it, 1433 ms (the rewrite again, and no code cache ever).
  Isolated mode alike (460 ms with the code cache, 704 ms without, 1600 ms
  with a new id). Google's home page, 2 alternated runs of 5 visits: with a
  kept id every script of 1 KB or more consumes its code cache from the
  fourth visit (9 to 11 scripts, 4.3 MB), off-thread parsing goes from 110
  ms to none (15 ms deserializing) and script evaluation from 327 ms to
  166 ms; with a new id per visit nothing is ever consumed. Chrome writes
  the code cache into the entry after the script ran and keeps it once the
  worker lets go of the response (when it is collected, or the worker
  stops): a browser that exits within seconds of a load loses what that
  load produced, and the next visit produces it again. What is kept is one partition's: an output's key
  now includes the request's top-level site, the site of the frame or
  worker that asks and whether it has credentials (the HTTP cache's
  partition), for inline scripts too, so a page of another site that loads
  the same script rewrites and compiles it for itself and takes the URL's
  entry (the first site's output moves under its key, and comes back
  without a rewrite); before, an output was shared by every site a
  controller's pages loaded. A client without a site of its own (a
  sandboxed frame) keeps nothing now, as in the HTTP cache. The kept
  response has only the headers a browser acts on for a script: the
  origin's `Server-Timing`, `Date`, `ETag` and request ids are not given
  to a later load. The cache holds 3000 entries (300 before, which
  Discord's 450 to 700 scripts pushed out of each other on every visit).
  (rewrite-cache suite; docs/same-origin-policy.md.)
- `navigator.storage.estimate()` counts an IndexedDB database as Chrome
  counts it on disk (measured: per database, store and record, and a value
  over 64 KiB at its snappy-compressed size), within 2% for the shapes the
  new storage-estimate suite compares; it counted the values' raw size (a
  megabyte of zeros: a megabyte, natively 50 KB).

- A site framed by another site gets storage of its own, keyed by the
  top-level site too, as Chrome partitions it: localStorage,
  sessionStorage, IndexedDB, Cache Storage, the origin private file
  system, BroadcastChannel, Web Locks, shared workers and emulated service
  worker registrations. It shared all of them with the site's own
  top-level pages. A worker is in its creator's partition before any of its
  script runs (a routed worker's route names it, a blob: worker's bootstrap
  sets it, an emulated service worker has its registration's). A
  `Partitioned` cookie (CHIPS) is kept per top-level site, and a request
  carries those of its own top-level site, a top-level page's request to
  another site included; third-party cookies without Partitioned are sent
  as before, as Chrome sends them by default. A first-party context keeps
  the keys and cookie ids it had, so everything stored before is still
  there (what a frame stored before stays its site's first-party data).
  (sop-partitions suite: the 48 checks, 24 in each mode, that differed
  read as natively.)
- `navigator.storage.estimate()` counts the page's own storage only: its
  partition's Cache Storage, origin private file system and IndexedDB, as
  the browser counts its origin's (localStorage is not counted). It counted
  every proxied site's stores and Stomp's own caches, so a megabyte another
  site stored showed in this one's usage. IndexedDB is sized from its
  values, where Chrome counts the compressed size on disk.
  (sop-escapes and sop-partitions suites.)
- A document whose inline scripts the rewrite workers prewrite no longer
  waits for them before its first byte, and its table of rewrites is a
  quarter of the size. CNN's first visit sent nothing for 2.1 to 2.5 s: one
  3.5 MB inline script took a worker 1.4 s (the split did not know its
  shape, a program of module chunks), and the service worker then rewrote
  the styles and built the shell. The table also carried every script's text
  three times, as its key, in its preamble and in the holder of its
  functions' sources, about 14 MB that the page's main thread compiled as a
  string literal (0.7 s at full speed). Now the shell is streamed (the
  inject bundle's script and the markup at once, the call that hands the
  client the markup and the table when the workers are done), a program of
  many statements is split across the workers like a Closure module, and the
  table names each text by where it stands in the markup and leaves out the
  preamble and the holder, which the client makes again from the text (the
  worker sends a rewrite whole when that would not give it byte for byte).
  The client still takes a rewrite only for the exact same kind and text.
  CNN, same-origin, medians of 4 alternated runs (first byte, first
  contentful paint, load): cold at full speed 2.1 to 0.65 s, 6.0 to 3.9 s,
  7.6 to 5.8 s (with no workers at all 4.8 s to first paint, natively 0.5
  s); cold with a four times slower CPU 2.5 to 0.76 s, 20.5 to 12.9 s, 24.8
  to 16.7 s; the same tab again at full speed 1.4 to 0.18 s, 3.4 to 2.4 s.
  (rewriter-unit: the new split and its inline form are the whole's rewrite
  byte for byte, and a packed rewrite comes back byte for byte, bare and
  not; 21 large scripts of Google, YouTube, Docs, CNN and Discord split and
  stitch to the whole's rewrite; prewrite: the streamed shell leaves no copy
  of the markup in the page.)
- An upload to a plain `http://` site no longer kills every request and socket
  the page has open. Epoxy sent a request body as one wisp message, and the
  holyWisp relays (`wss://holywisp.fracit.al/`) close a connection with 1009,
  every stream on it, when a message is over their `max-message-size` of
  262149 bytes; a 300 KB upload was enough. HTTPS was spared because each TLS
  record goes out as its own message. The epoxy build now writes DATA packets
  of at most 64 KiB, and each packet waits for the stream's CONTINUE credit
  (TCP writes never looked at it). No wisp extension carries a server's bound,
  so the 64 KiB is fixed, far under any server's. A UDP datagram over it (more
  than an IPv4 datagram carries) fails that send alone with `EMSGSIZE` through
  the new `send(datagram)` on `connect_udp`'s stream; the connection and the
  stream stay up. Measured live through wss://holywisp.fracit.al/: 300 KB, 3
  MiB and 20 MiB uploads arrive while two downloads run on the same
  connection, largest message 65541 bytes (the 300 KB one went out as a
  300309-byte message and closed the connection before). The new
  wisp-message-size suite puts a relay that enforces the edges' limit in front
  of the demo's wisp: 300 KB, 3 MiB and 20 MiB uploads with responses
  streaming across them, a 20 MiB upload whose CONTINUE the relay hands out
  one window at a time (it stops at its credit and never sends past it), and
  UDP datagrams of 1200, 60000 and 70000 bytes. libcurl's wisp client already
  writes at most 64 KiB (curl's upload buffer).
- The demo's wisp server, wisp-js, goes to 0.5.3. 0.5.2 sent its periodic
  CONTINUE to UDP streams only (the stream type test was inverted), so a TCP
  stream never got credit back after its first window of 128 packets, and a
  client that honours credit stalled there: libcurl.js took 19.6 s for 400
  sequential requests through it, 1.6 s through 0.5.3.
- stomp-h3's HTTP/3 SETTINGS, control stream, QPACK streams, PRIORITY_UPDATE
  frames, QUIC transport parameter order and 1250-byte Initials are Chrome
  152's (docs/fingerprint.md); responses may use the QPACK dynamic table.
- A site that publishes an ECH config in its HTTPS DNS record gets real
  Encrypted Client Hello through epoxy, as from Chrome: crypto.cloudflare.com
  reads `sni=encrypted`, tls-ech.dev "You are using ECH", defo.ie `SUCCESS`
  (they read plaintext SNI and GREASE before). EpoxyTransport's new `ech_dns`
  option names a DNS-over-HTTPS endpoint asked for each name's record; the
  demo sets Cloudflare's (`STOMP_ECH_DNS`, `?noech`). The outer and inner
  hello are Chrome's (compared with a local ECH server: same extensions,
  order and 144-byte payload), a server's retry configs get one more
  connection and a server with ECH off one without it, as Chrome does
  (docs/fingerprint.md). Sites without a config see the same GREASE ECH and
  JA4 as before.
- A close the server starts reaches a proxied WebSocket with the server's
  code and reason, as natively: epoxy never read the close frame and
  reported every close as 1000 "Closed by remote", so a page saw 1000 for
  4000 "srv", for 1001 and for a connection that ended without any close
  frame alike. The epoxy build passes the frame's status and reason on
  (1005 for none, 1006 for no frame, a UTF-8 reason intact). The
  websocket-close suite now compares the server's closes with native too
  (no status, 4000 with a reason, 1000, 1001, a UTF-8 reason, a 123-byte
  one, a dropped connection), in both modes.
- An IPv6 literal (`https://[::1]:8443/`, `wss://[2001:db8::1]/`) loads
  through epoxy. Epoxy handed the host with the URL's brackets to rustls,
  which refused `[::1]` as an invalid DNS name, and to the wisp server, which
  could not resolve it, so http, https and wss to an IPv6 address all failed
  (epoxy-ipv6 suite: a page, raw requests and a WebSocket against a server
  on `::1` with a certificate for the address; Host reads `[::1]:port` as
  Chrome sends it). epoxy's `pem_files` option is passed through for it.
- The DOM hooks cost less per keystroke. On Google, typing with a four
  times slower CPU, they swapped an element's prototype several times for
  every node the page inserted and every attribute it read or wrote, and
  looked through the whole hook list on each write. Reads that need no hook
  (an insertion's nodes, scripts and styles, `getAttribute` and
  `hasAttribute` outside a hook, a write to an attribute no hook watches)
  now call the browser's accessors on the node directly, the hook lists are
  kept per element name and attribute, the client's URL is decoded only
  when the base URL changes, and an inline style with nothing to route (or
  one rewritten a moment ago) does not go to the rewriter library. Google,
  same-origin, 4x slower CPU, 10 s of typing from the search box showing,
  medians of 6 alternated runs: long tasks 21 to 10 (native 4), main-thread
  time in them 2.27 s to 1.51 s (native 0.40 s), TBT 1.20 s to 1.03 s
  (native 0.23 s); the worst keystroke (0.55 s, Google compiling the search
  code it loads on the first key) is unchanged, and at full speed the two
  measure the same. Storage writes still go through the synchronous bridge:
  sending them asynchronously would let another frame of the site read the
  old value right after the write, which natively it never does.
- A site framed by another site gets storage of its own, keyed by the
  top-level site too, as Chrome partitions it: localStorage,
  sessionStorage, IndexedDB, Cache Storage, the origin private file
  system, BroadcastChannel, Web Locks, shared workers and emulated service
  worker registrations. It shared all of them with the site's own
  top-level pages. A worker is in its creator's partition before any of its
  script runs (a routed worker's route names it, a blob: worker's bootstrap
  sets it, an emulated service worker has its registration's). A
  `Partitioned` cookie (CHIPS) is kept per top-level site, and a request
  carries those of its own top-level site, a top-level page's request to
  another site included; third-party cookies without Partitioned are sent
  as before, as Chrome sends them by default. A first-party context keeps
  the keys and cookie ids it had, so everything stored before is still
  there (what a frame stored before stays its site's first-party data).
  (sop-partitions suite: the 48 checks, 24 in each mode, that differed
  read as natively.)
- `navigator.storage.estimate()` counts the page's own storage only: its
  partition's Cache Storage, origin private file system and IndexedDB, as
  the browser counts its origin's (localStorage is not counted). It counted
  every proxied site's stores and Stomp's own caches, so a megabyte another
  site stored showed in this one's usage. IndexedDB is sized from its
  values, where Chrome counts the compressed size on disk.
  (sop-escapes and sop-partitions suites.)
- Emulated service workers are on by default (`serviceWorkers`, on unless
  `false`; the demo turns them off with `?nosw`, and `?sw` still sets the
  suites' timeouts). A proxied page without `navigator.serviceWorker` reads
  as a proxy: every Chrome page in a secure context has it, and sites that
  call `navigator.serviceWorker.register()` without checking threw
  (squoosh.app, whatpwacando.today). Swept natively and through the demo
  with the flag on and off (YouTube's home and a /watch page, Google,
  Gmail and Google sign-in, x.com, Discord, Spotify, Reddit, GitHub, MDN,
  web.dev, squoosh.app, Excalidraw, whatpwacando.today, Facebook,
  Wikipedia, developer.chrome.com, diagrams.net): the eight sites that
  register a worker register it, activate it and, where natively, are
  controlled after a reload, element counts are the native ones, and no
  page error comes with the flag on; a frame that never reads
  `navigator.serviceWorker` costs no more memory, and a site without a
  worker loads as fast. (docs/service-workers.md.)
- Turning emulated service workers on costs a frame that never reads
  `navigator.serviceWorker` nothing: the container and the few hundred
  hooked members behind it were made in every document, 56 KB of heap per
  frame (measure-frame-memory: 1,276 KB against 1,220 KB with them off), and
  are now made on the first read, or at once in a document a worker
  controls (1,220 KB). A page that keeps a member of a service worker
  interface's prototype from before that read holds the native one.
- An emulated service worker's navigation preload works: with
  `navigationPreload.enable()`, a GET navigation's request goes out as soon
  as it is routed, in parallel with the worker's start, with
  `Service-Worker-Navigation-Preload` and the navigation's own destination,
  mode and cookies, and `event.preloadResponse` resolves to its answer (a
  `basic` Response of the real URL) where it resolved `undefined`. A worker
  that passes it to `respondWith` unread, as YouTube's does for every
  navigation outside its app shell, hands the page the network's answer
  without the body crossing to the worker and back; YouTube's worker used
  to fetch the page again without the header, as a `fetch` (Sec-Fetch-Dest
  `empty`). One that answers nothing leaves the preload unused and the
  navigation goes out again, as Chrome 152 does. (service-worker-preload
  suite, against a real worker, both modes.)
- A proxied page's `navigator.getInstalledRelatedApps()` resolves to an
  empty list, as a top-level page's with none of its related apps
  installed. The browser rejects it in any frame ("only supported in
  top-level browsing contexts"), and the host shows every proxied page in
  one, so whatpwacando.today threw where natively it runs. A frame nested
  in a proxied page still gets the rejection. (tells suite.)
- A background fetch's downloads are the page's CORS requests, as
  natively: one of another site without Access-Control-Allow-Origin fails
  the fetch (`fetch-error`), one with it succeeds. (sop-escapes suite.)
- A page's emulated service worker sees the same-origin policy as a real
  one does: a request it answers is not preflighted or checked against the
  page's origin, its own fetches are judged as its origin's, an opaque
  answer to a request that is not no-cors is a network error and one to a
  no-cors request reads as opaque (an image shows, a canvas that draws it
  is tainted), a `cors` answer reads as `cors`, a body it made as `basic`.
  The CORS change had refused its answers to cross-origin requests and
  turned an opaque answer into a network fetch. The Cache API keeps a `cors`
  or opaque response's type. (sop-escapes suite, `?sw`.)
- The worker reuses an output it just gave a document only for a request
  the same-origin policy judges the same way (its copy marker, opaque
  origin and preflight headers are in the key) and never for a hop of a
  redirect chain. (sop-escapes suite.)
- A request a host rule sends with another Origin (the host's own, for a
  site that answers only that) is checked against that origin by the CORS
  check, not the page's: the site's Access-Control-Allow-Origin names the
  Origin it was sent, and the host vouched for it. (rules suite.)
- A page can no longer pass its own read for one of the proxy's copies by
  replacing `Headers.prototype[Symbol.iterator]` or the `Request.prototype`
  `headers` getter: the browser read the request's headers through them
  after the inject had dropped the proxy's marker, so a page could add it
  back and read another site's response whole. fetch and XMLHttpRequest now
  hand the browser the page's headers as a record read with the browser's
  own members. (sop-escapes suite.)
- Resource timing of another site's resources is restricted unless its
  Timing-Allow-Origin names the page, as natively: timings, sizes and
  Server-Timing read 0 or empty, in the entry and its `toJSON()`, and
  another site's status and content type need CORS. Every entry showed
  every detail before, since every route is same-origin to the browser.
  `workerStart` is 0 on every entry (it was the proxy worker's start time).
  (sop-escapes suite.)
- A blob: worker and a document the page made itself (a `javascript:`
  URL's, a blob: document, a data: one) are judged by their real origin,
  after a service worker restart too: the worker keeps what it learns of
  them in IndexedDB. A `javascript:` document's requests counted as an
  opaque origin's, and after a restart so did a blob: worker's, so the
  same-origin policy refused their CORS reads of their own site.
  (sop-escapes, blob-worker-site and inline-documents suites.)
- `document.domain`'s setter checks the value as Chrome does (parsed as a
  host, an IP host only to itself, a public suffix refused as a top-level
  domain, Chrome's messages) and then has no effect, as in the
  origin-keyed agent cluster every document gets by default; it used to
  accept a parent domain and read it back. (sop-escapes suite.)
- The Navigation API shows a document only its own origin's entries:
  `navigation.entries()` listed the entries of every site the frame had
  shown, their full URLs and keys included, and `canGoBack` said yes into
  another site. History (`history.length`, `back()`, `go()`) and the
  host's Back and Forward buttons keep the frame's whole list, as natively.
  (sop-escapes suite.)
- Web Locks are per proxied site. They were one namespace for every site
  behind the proxy: a lock another site held was held for this one, and
  `navigator.locks.query()` listed its names. (sop-escapes suite.)
- A canvas that drew another site's image without CORS is tainted, as
  natively: `toDataURL`, `toBlob`, `getImageData` and an OffscreenCanvas's
  `convertToBlob` throw the browser's SecurityError, and WebGL refuses such
  an image as a texture. Every image is same-origin to the browser through
  the proxy, so a page could read the pixels of any other site's image,
  including through a pattern, an ImageBitmap, another canvas or a video.
  (sop-escapes suite; `drawImage` costs the same as natively.)
- A tainted OffscreenCanvas's `convertToBlob` rejects with the message of
  the Chrome it runs in. Chrome 153 reworded it ('A tainted OffscreenCanvas
  may not be exported.' where 152 said 'Tainted "OffscreenCanvas" may not be
  exported.'); the proxy answered with 152's wording everywhere.
- A frame of another site no longer takes over its frame element in the
  page above it. Its inject follows whether the frame is rendered with an
  IntersectionObserver on that element and read each entry's `target`; when
  the page's wrapper for the element had been garbage collected (the page
  held no reference to it), that read made a new one in the frame's realm,
  with the frame's `HTMLIFrameElement.prototype`. From then on the page's
  `iframe.contentWindow` ran the frame's hooks and returned another stand-in
  than `event.source` did, so a sandboxed frame's messages reached its
  parent from a window that matched none of its frames (sandbox-messages
  failed in about 1 run in 3, more on a busy machine). The observer now
  names its element itself and keeps it referenced, so the page's wrapper is
  never made again elsewhere (sandbox-messages suite, which now collects
  garbage in the frame and holds the page's load, so it hit this every run).
- A proxied page can no longer read another site's responses the browser
  would refuse it. Every route is same-origin to the browser, so a `fetch`
  or XMLHttpRequest of another site came back whole, every header and the
  body, whatever its CORS answer, and a `no-cors` fetch was readable too.
  The service worker now applies the CORS protocol between the real
  origins as Chrome does: preflights for non-simple methods and headers,
  the Access-Control-Allow-Origin, -Credentials, -Methods and -Headers
  checks (a failure is a network error, as natively), only the exposed
  headers on a `cors` response, `mode: 'same-origin'` refused before the
  network, Cross-Origin-Resource-Policy on `no-cors` loads, and nothing of a
  page's `no-cors` fetch of another origin, which reads as an opaque
  response. `crossorigin` images, scripts and fonts of another site without
  CORS now fail to load, and `Response.type` is `cors` or `opaque` where the
  browser says so. Access-Control-* response headers are no longer
  stripped. (sop-escapes suite, docs/same-origin-policy.md.)
- An emulated service worker has `cookieStore`, over the same jar as the
  site's pages, and its registration's cookie change subscriptions fire
  (`serviceWorkers: true`). `get`, `getAll`, `set` and `delete` answer with
  the page's dictionaries and errors (the four methods are now shared
  between a document's `cookieStore` and the worker's), with a service
  worker's `url` rule as Chrome 152 applies it: only the worker's own script
  URL, query and fragment aside, and "URL must be within Service Worker
  scope" for anything else, the scope included. A change of a cookie a
  subscription covers, whoever made it, reaches the worker as an
  `ExtendableCookieChangeEvent`, one per cookie, with Chrome's members
  (service-worker-cookies suite, against a real worker in both modes; the
  service worker global now compares `CookieStore` and `cookieStore` too).
  The event constructors stand behind the Proxy module's `standInClass`.
- An emulated service worker's global reads as a real one's, name for name
  (service-worker-global suite, against a Chrome service worker). The push,
  sync, periodic sync, background fetch, payment, notification and cookie
  change interfaces and their `on...` handlers are there; the
  dedicated-worker APIs a service worker lacks (WebCodecs, MediaSource,
  WebUSB, WebHID, Web Serial, the RTC script transform, the old file system
  API), `URL.createObjectURL` and `URL.revokeObjectURL` are gone; `fetch`,
  `importScripts`, `setTimeout` and `setInterval` are inherited again
  rather than the global's own; every service worker interface's
  `prototype` is read-only; and `new`-less calls of `ExtendableEvent`,
  `FetchEvent` and the rest throw the browser's "Please use the 'new'
  operator" instead of naming a minified class. The registration's
  `sync`, `periodicSync`, `backgroundFetch`, `paymentManager` and `cookies`
  are no longer removed but simulated as Chrome 152 answers: a sync runs
  and the worker gets its `SyncEvent`; periodic sync is refused for want of
  the permission; a background fetch downloads through the proxy and the
  worker gets `backgroundfetchsuccess` with its records; the payment manager
  and cookie change subscriptions keep what they are given; push answers
  `prompt` in a page, `denied` in the worker and `subscribe()` rejects
  `AbortError`, as Chrome without the notification permission
  (service-workers, line for line against the same page natively).
- A page's emulated service worker registration object always shows the
  state its events and promises say. Stomp's service worker answers a
  page's call (`register`, `getRegistration`, `update`) on a port of its
  own and sends state changes as messages, so an answer could overtake the
  steps sent before it: `navigator.serviceWorker.ready` resolved while the
  registration's `active` was still `null` (a slow page under load read
  `reg.active.state` and threw), and steps were skipped as already applied
  when the answer's snapshot ran ahead of them (an `updatefound` went
  missing). An answer now resolves only once the steps it includes have
  arrived and are applied (they are numbered per registration), every event
  waits while a call is in flight so none overtakes another, `ready`
  resolves only when the registration object itself has an active worker,
  and `update()` answers with the registration it updated. The suites have
  a mode in which every event reaches the page 300 ms after the answers
  (`serviceWorkerEventDelay`, the demo's `?swdelay=300`), which made the
  failure happen every time (service-workers, service-worker-updates).
- `cookieStore` is there, as natively in a secure context, over the
  proxy's jar (native-shapes suite, both modes): the page's `cookieStore` is
  the browser's own CookieStore (identity, prototype, `onchange` and the
  event methods native), and `get`, `getAll`, `set` and `delete` read and
  write the jar `document.cookie` uses, so either sees the other's writes
  (a `set` shows in `document.cookie` once its promise settles, as
  natively). What they answer is Chrome's: `secure` always, `sameSite`
  `strict` by default, `path` `/` (a path without a trailing slash gets
  one), `domain` null for a host-only cookie and an IP, `expires` in
  milliseconds kept to the fraction and at most 400 days away,
  `partitioned` kept apart from the unpartitioned cookie of the same name
  (also for `document.cookie` and Set-Cookie, where Partitioned without
  Secure is refused, as natively), and every error Chrome gives for its
  arguments, word for word (an empty name and value, `=` in a name, a
  domain that does not match, a leading dot, a relative path, the
  `__Host-` rules, a malformed cookie, a missing member, a bad enum, a
  non-finite expiry, a URL that is not the document's). Each change of the
  cookies the document can see (its own writes, a response's Set-Cookie,
  another document's write) fires a `change` CookieChangeEvent with the
  `changed` or `deleted` cookie, one per cookie, and the browser's own
  events about the proxy origin's cookies (which the sync bridge writes)
  never reach the page. Before, `cookieStore` was deleted from every page,
  where natively Chrome has it in every secure context; a document whose
  real URL is not secure still has none of it, `CookieStore` and
  `CookieChangeEvent` included. Dedicated workers have none natively and
  none through the proxy.
- `HTMLAudioElement.prototype.constructor` is `HTMLAudioElement` again, as
  natively; it was the proxy's `Audio`, so an `<audio>`'s `constructor`
  (made by `new Audio()`, `createElement` or markup) was `Audio`. `Audio`
  is a named constructor whose `prototype` is HTMLAudioElement's, like
  `Image` and `Option`, which the proxy does not replace and which already
  read as natively (native-shapes suite, both modes). Called without `new`,
  `Audio` threw a message naming Worker and an 'Image' operator; it throws
  the browser's own error now.
- Every constructor the inject replaces reads as the browser's
  (native-shapes suite, both modes, window and worker): XMLHttpRequest and
  its event target and upload, EventSource, WebSocket, WebSocketStream,
  Worker, SharedWorker, Request, Blob, File, Storage, BroadcastChannel,
  MutationObserver (and WebKitMutationObserver, the same constructor
  natively), ReportingObserver, MediaMetadata, FontFace, Function and the
  generator and async function constructors. Their `prototype` was
  writable (natively neither writable, enumerable nor configurable);
  EventSource had no `CONNECTING`, `OPEN` or `CLOSED`; most inherited from
  Function.prototype instead of their parent (`EventTarget`, `Blob`,
  `XMLHttpRequestEventTarget`, `Function` for the generator constructors);
  `XMLHttpRequest.prototype.constructor`, `WebSocket`'s and `Storage`'s
  were other functions, so an instance's `constructor` was not the global;
  the generator constructors' prototypes had a writable `constructor`.
  Called without `new`, with too few arguments, or (XMLHttpRequestEventTarget,
  XMLHttpRequestUpload, Storage) at all, each now throws the browser's own
  error from the native constructor, where they threw made-up messages
  (`Failed to construct 'te'`, a `DOMException` for Request) or, for
  EventSource, constructed anyway.
- The page's `location` reads as natively member by member (native-shapes
  suite, both modes). `toString` and `valueOf` were copies of `assign`
  (`location.toString.name` was `'assign'`, its length 1, its source
  `function assign() { [native code] }`); `valueOf` is the realm's
  `Object.prototype.valueOf` again, as natively, and the `ancestorOrigins`
  getter, which was the proxy's own arrow function (its source showed),
  is a wrapped native getter, not configurable. The stand-in has the real
  location's own properties in their order with their descriptors,
  `Symbol.toPrimitive` (undefined) included, which it lacked. A member
  called on anything but a location throws "Illegal invocation" as
  natively: `assign` and `replace` navigated and `href`'s getter answered
  whatever they were called on.
- An inline style with a URL in it reads as natively, however the page
  wrote it and however it reads it (native-shapes suite, both modes). After
  a CSSOM write (`el.style.x = ...`, `cssText`, `setProperty`,
  `removeProperty`, `el.style = text`, the Typed OM) the element's
  attribute views (`attributes`, its attribute node, `getAttributeNode`,
  `outerHTML`) showed the routed URL, and `getAttribute('style')` kept the
  value the page had written before the write: the browser rewrites the
  attribute on such a write, so the page's copy of it now goes and every
  view reads the browser's serialisation with the page's url()s. `cssText`,
  `getPropertyValue` and the named properties gave the page's url() token
  as typed (`url(a.png)`, `url('a.png')`) where the CSSOM serialises
  `url("a.png")`; `outerHTML` of a CSSOM-written style put raw quotes inside
  the attribute (`style="...url("a.png")"`), where the browser writes
  `&quot;` and escapes `&`; and a copy of such an element (cloneNode,
  inserted) read the routes back.
- An emulated service worker's global reads as a real one's, name for name
  (service-worker-global suite, against a Chrome service worker). The push,
  sync, periodic sync, background fetch, payment, notification and cookie
  change interfaces and their `on...` handlers are there; the
  dedicated-worker APIs a service worker lacks (WebCodecs, MediaSource,
  WebUSB, WebHID, Web Serial, the RTC script transform, the old file system
  API), `URL.createObjectURL` and `URL.revokeObjectURL` are gone; `fetch`,
  `importScripts`, `setTimeout` and `setInterval` are inherited again
  rather than the global's own; every service worker interface's
  `prototype` is read-only; and `new`-less calls of `ExtendableEvent`,
  `FetchEvent` and the rest throw the browser's "Please use the 'new'
  operator" instead of naming a minified class. The registration's
  `sync`, `periodicSync`, `backgroundFetch`, `paymentManager` and `cookies`
  are no longer removed but simulated as Chrome 152 answers: a sync runs
  and the worker gets its `SyncEvent`; periodic sync is refused for want of
  the permission; a background fetch downloads through the proxy and the
  worker gets `backgroundfetchsuccess` with its records; the payment manager
  and cookie change subscriptions keep what they are given; push answers
  `prompt` in a page, `denied` in the worker and `subscribe()` rejects
  `AbortError`, as Chrome without the notification permission
  (service-workers, line for line against the same page natively).
- A page's emulated service worker registration object always shows the
  state its events and promises say. Stomp's service worker answers a
  page's call (`register`, `getRegistration`, `update`) on a port of its
  own and sends state changes as messages, so an answer could overtake the
  steps sent before it: `navigator.serviceWorker.ready` resolved while the
  registration's `active` was still `null` (a slow page under load read
  `reg.active.state` and threw), and steps were skipped as already applied
  when the answer's snapshot ran ahead of them (an `updatefound` went
  missing). An answer now resolves only once the steps it includes have
  arrived and are applied (they are numbered per registration), every event
  waits while a call is in flight so none overtakes another, `ready`
  resolves only when the registration object itself has an active worker,
  and `update()` answers with the registration it updated. The suites have
  a mode in which every event reaches the page 300 ms after the answers
  (`serviceWorkerEventDelay`, the demo's `?swdelay=300`), which made the
  failure happen every time (service-workers, service-worker-updates).
- `ast-types` is dropped. The JS rewriter built its new nodes with its
  builders, and loading it builds its definitions of every node kind of
  every dialect (Flow, TypeScript, Babel, JSX): about 450 KB of heap in
  each realm that evaluates it, which is every proxied frame and worker.
  `src/builders.ts` builds the twenty kinds the rewriter makes as plain
  objects with the fields, defaults and key order ast-types gave them (the
  rewriter's output over the speed corpus and the test pages' scripts is
  byte for byte the same). A proxied frame costs 1,380 KB of heap instead of
  1,830 (native: 400) and 3.1 MB of renderer memory instead of 3.6
  (measure-frame-memory suite, 60 frames of an ad-like page).
- The codecs import the three parts of crypto-js they use (AES, Base64,
  UTF-8) instead of the whole library, whose other ciphers and hashes cost
  each proxied frame about 100 KB of heap: 1,280 KB a frame instead of
  1,380 (measure-frame-memory). Encoded URLs are the same.
- A proxied frame no longer evaluates the rewriter. meriyah, escodegen,
  css-tree and tldts, with their tables (meriyah's 272 KB unicode table,
  css-tree's grammar and token buffers, the public suffix list), are a
  library of their own (`src/rewriterLib.ts`, built by `build.js`) that the
  inject bundles carry as a function they do not call until a rewrite
  needs it. A proxied top evaluates it once, before any page code runs, in
  an about:blank frame's realm it removes again at once, and every frame
  under it (of its own site or another) rewrites through that copy: no
  page can reach the realm, so no page can change what its code reads, and
  the library speaks only strings, numbers and booleans and keeps nothing
  of one caller for the next (each call carries the document's URL, codec,
  config, blob: origins and route scopes). A document sandboxed without
  allow-same-origin, a frame whose top is gone or of another build, and a
  worker evaluate their own copy the first time they rewrite something. A
  frame costs 1,050 KB of heap instead of 1,280 and 2.3 MB of renderer
  memory instead of 3.0 (native: 400 KB and 1.1 MB; measure-frame-memory,
  60 ad-like frames, same-site and of another site alike), and the 60
  frames load in 1.2 s instead of 1.8. The core no longer decodes the
  page's markup with entities' HTML decoder (the shell only escapes `&`,
  `<`, `>` and U+00A0).
- The rewriters load less of css-tree and none of the source-map
  libraries. The CSS rewriter imports css-tree's parser, walker and
  generator instead of the whole syntax, which also built a lexer from the
  grammar of every property, type and at-rule; `source-map` (escodegen)
  and `source-map-js` (css-tree's generator), loaded only to print source
  maps, are replaced at build time by `src/noSourceMaps.ts`. The rewriter
  library a top or a sandboxed frame evaluates costs 223 KB of heap instead
  of 263 and 1.0 MB of renderer memory instead of 1.1; the service worker
  bundle is 510 KB instead of 665, the inject bundle 697 KB instead of 849.
  The CSS rewriter's output over 220 stylesheets (6.5 MB) and the rewriter
  library's answers over 499 calls are the same.
- meriyah's 272 KB table of Unicode identifier characters is built the
  first time a script has a character past ASCII where an identifier may
  start or go on, instead of when meriyah loads (build.js patches its
  source as it bundles it, and fails the build if a meriyah upgrade
  changes the shape it patches). Each realm that holds the rewriter (the
  service worker, each rewrite worker, a top's rewriter realm, a sandboxed
  frame's own copy) saves it: the library costs 0.8 MB of renderer memory
  per realm instead of 1.0.
- A proxied frame costs 1,015 KB of heap again instead of 1,220, and 2.5
  MB of renderer memory instead of 2.8 (native: 400 KB and 1.1 MB;
  measure-frame-memory, 60 ad-like frames, Chrome 152 and 156 alike). Since
  the memory work it had grown by 150 KB: canvas tainting made the WebGL
  interfaces in every frame to hook their texture uploads (+100 KB, the
  browser makes an interface the first time anything names it), WebRTC's
  hooks +22 KB, resource timing +9 KB, and document.domain's check imported
  tldts into the inject bundle beside the rewriter library's copy (+133 KB
  of bundle, +160 KB of renderer memory a frame). WebGL's methods are now
  hooked the first time `getContext` hands out a WebGL context in the
  realm, document.domain asks the rewriter library (the ICANN section of
  the list, as before), and every hook's wrapper is made with the native's
  name and length already (a computed key and that many parameters) instead
  of defining them, which left each of the 600 wrappers of a frame with a
  property dictionary of its own; a wrapper keeps the native it stands for
  instead of a copy of its source text. A new `frame-cost` suite, which CI
  runs, fails when a proxied frame of 20 costs more than 1,120 KB of heap
  (this build: 1,048) or `dist/injectDocument.js` grows past 850 KB (790).
- `caches.match()` looks in the page's own origin's caches only. It searched
  every cache of the proxy origin, so a page (or a service worker) could
  read another proxied site's cached responses, and Stomp's own HTTP cache,
  whose entries are keyed by the real URLs and hold the origin's raw,
  unrewritten bodies; `cacheName` named another site's cache too. It now
  looks in the origin's caches in the order they were made, as the browser
  does (service-worker-isolation suite).
- Pages and their emulated service workers talk as natively
  (`serviceWorkers: true`). `ServiceWorker.postMessage` reaches the worker as
  an `ExtendableMessageEvent` (origin, a `WindowClient` source, transferred
  ports, `waitUntil` only while it runs); `Client.postMessage` reaches the
  page's `navigator.serviceWorker` as a `MessageEvent` whose source is the
  worker's `ServiceWorker`, held until `startMessages()`, an `onmessage`
  handler or the end of parsing. `clients.matchAll()`, `clients.get()`,
  `clients.claim()` and `WindowClient.navigate()` see the site's own pages
  only, a proxied page as the top-level page it stands for;
  `clients.openWindow()` and `focus()` refuse as without a user's click
  (service-worker-messages suite, against the same page natively, both
  modes). One site's worker never sees another site's requests, clients or
  caches, and the only real registration is Stomp's own
  (service-worker-isolation suite).
- An emulated service worker takes the navigations within its scope
  (`serviceWorkers: true`), so a cache-first app opens while its site is
  unreachable. A document (or a worker's script) whose URL is in a
  registration's scope is controlled by it from its first script: the
  shell carries the registration, so `navigator.serviceWorker.controller`
  is set on a reload as natively, and its subresources go to the worker.
  The worker gets the navigation as a `FetchEvent` (mode `navigate`,
  redirect `manual`, `resultingClientId` the new document's); what it
  answers, from its cache or the network, is wrapped in Stomp's shell like
  any document, so the page still has the inject. Once the navigation is
  answered, the registration checks its script for new bytes (the spec's
  soft update), and a waiting worker whose old version no longer controls a
  page goes on (service-worker-offline: a reload, then a load with the
  site's server dropping every connection, against the same app natively;
  service-worker-updates: new bytes found by the check after a navigation,
  and the new worker controls the page; both modes).
- An emulated service worker answers the subresource requests of the pages
  it controls (`serviceWorkers: true`). Stomp's service worker hands each
  request of a controlled page (any URL, other origins included, as
  natively) to the worker as a `FetchEvent` whose request shows the page's
  URL, method, headers, body, mode, destination, credentials, redirect mode
  and referrer, after the host's request rules and before the HTTP cache.
  `respondWith` is honoured with its checks: a body, headers and status the
  worker makes, `Response.redirect` (a relative URL resolves against the
  site, not the proxy), a stream (it arrives as the worker produces it),
  `fetch(event.request)` passed through, `Response.error()` and a value that
  is no Response (a network error, as natively). A request it leaves alone
  goes to the network, and so does one whose worker does not start in 10 s,
  does not say within 5 s whether it answers, or does not settle
  `respondWith` in 30 s: the page never hangs on it. Scripts and
  stylesheets it answers are rewritten like the origin's. A worker that is
  not running (the browser stopped every service worker) starts again for
  the next request (service-worker-fetch suite, against the same page
  natively, both modes).
- Proxied pages can have service workers, emulated, behind the new
  `serviceWorkers` controller option (on by default; `false` turns them
  off, the demo's `?nosw`).
  `navigator.serviceWorker` used to be absent, because a page that
  registered a real worker on the proxy origin could serve itself and every
  other site. Now `register()` runs the page's worker script in a dedicated
  Worker the controller starts, with the worker inject and a global that
  reads as a `ServiceWorkerGlobalScope` (`registration`, `serviceWorker`,
  `clients`, `skipWaiting()`, `install` and `activate` events with
  `waitUntil`, `clients.claim()`), and nothing real is ever registered.
  Registrations persist per site in Stomp's service worker, the lifecycle
  runs in the spec's order (`installing`, `installed`, `activating`,
  `activated`, `redundant`, with `updatefound`, `statechange` and
  `controllerchange` in their places), `register()` rejects a bad script with
  the browser's own errors, and `update()` installs a new version only when
  the script's bytes changed. `ServiceWorkerRegistration` has `installing`,
  `waiting`, `active`, `scope`, `updateViaCache`, `update()`,
  `unregister()` and a navigation preload stub; push answers as with the
  permission denied, and sync, periodic sync and background fetch are
  absent, as in a browser without them (service-workers and
  service-worker-updates suites, line for line against the same pages
  loaded natively, both modes). docs/service-workers.md has the design.
- The demo opened as `localhost` works in a browser that blocks third-party
  cookies (Brave and incognito windows by default, a setting in Chrome). Its
  proxy origin, `127.0.0.1`, is another site, so the browser gave the
  controller frame no service worker ("The user denied permission to use
  Service Worker") and nothing loaded, while the same-origin live demo and
  `127.0.0.1` itself worked. `RemoteController.wait()` now rejects with an
  error named `StorageBlockedError` that names the cause, and the demo's
  local default falls back to the same-origin controller with an
  `Isolation` console badge saying why; isolation a deployment asked for
  (`STOMP_PROXY_ORIGIN`) stays an error (storage-blocked suite).
- WebRTC no longer shows a proxied page the user's address or sends a
  packet where the page says. The browser's ICE agent sends its own packets,
  past the proxy: a STUN server the page named heard from the user's address
  and handed the page a `srflx` candidate with it (browserleaks.com/webrtc
  showed the real address through the live site and the local demo), a TURN
  server or a remote candidate the page chose got requests and connectivity
  checks, and once the proxy origin had camera or microphone access host
  candidates carried the machine's local addresses. `RTCPeerConnection`
  stays the browser's own and behaves as on a network that drops UDP: each
  STUN/TURN server is handed to the browser as `255.255.255.255` (a send the
  kernel refuses), so it times out as natively, 701 errors and all, and reads
  back as the page's; a remote candidate is handed over only when it is a
  host name a connection of this browser showed a page, so two proxied pages
  still open a data channel; real addresses read as mDNS names everywhere
  (events, descriptions, `RTCIceTransport`, stats, errors), in every realm the
  inject covers. A tcpdump of the uplink saw 156 packets to the page's
  servers and candidates natively and none through either demo mode
  (webrtc suite, 59 checks against the same pages loaded natively, both
  modes, with and without media access; docs/webrtc.md).
- Reading another window (`parent`, `top`, `frames[i]`) costs a few
  microseconds again. The Context module decided whether the reader may
  hold the window as it is by decoding both documents' routed URLs on every
  read, about 20 us each; the ad frames of a crazygames game page (about
  200, each walking the frame tree) kept the renderer's main thread busy
  for good, so the tab stopped answering. It compares the documents' site
  keys (`siteKey`, kept per document) instead: 5,000 reads take 20 ms
  (100 ms before, 3 ms natively).
- Markup the inject parses or copies only to rewrite or serialize it no
  longer stays in memory for the page's life, and the shell's copy of a
  page loads nothing. A `<source media>` listens to its media query in any
  document of the window (a DOMParser's, an inert template's, one from
  `createHTMLDocument`) and Blink keeps a listened MediaQueryList alive as
  a pending activity; an `<img>` listened to the viewport of the page's own
  document, where the shell built its copy. Wikipedia kept three copies of
  every page (18,700 nodes after a GC, 4,700 natively; now 5,300), Notion
  its whole markup, Poki 10,000 nodes, and every innerHTML, outerHTML,
  insertAdjacentHTML, getHTML, XMLSerializer or document.write with a
  `<picture>` in it kept one more copy, so a page that rendered pictures
  through innerHTML grew without bound. The shell's copy, in the page's
  document, also fetched every `<video>` and `<audio>` a second time. Each
  throwaway copy now lets its sources and images go (`releaseMarkup`), and
  the shell builds its copy in an inert document, as writes do.
- A document's inline scripts and styles are rewritten by the service
  worker and its rewrite workers, not on the page's main thread. The client
  rewrote every one while it loaded the document, the page's longest task:
  on Google with four times slower CPU the page answered a keystroke after
  0.9 s at worst in the ten seconds after it showed (0.37 s natively), and
  CNN's 3.7 MB of inline script and 3.3 MB of inline CSS took 1.7 s of a
  2.9 s task. The worker finds them in the markup, has the rewrite workers
  rewrite the scripts side by side (kept in the rewrite cache when the
  document may be kept), rewrites the styles, and sends the outputs with the
  markup; the client takes an output only for the exact same kind and text,
  and rewrites anything else as before (a page with no live rewrite worker
  gets none, nor one with a `<base href>`, whose URLs the client resolves
  against it; the client uses the outputs only while its URL is the one
  they were made for). A script the page makes from the text of one of its markup
  scripts (CNN's loader) gets the same rewrite without the preamble. A
  `<style>`'s stand-in script, the client's own code, is no longer rewritten
  as a page script (CNN's 3 MB stylesheet as a string literal, half a
  second), and a large style text routed once is not routed again, nor is
  the routed text coming back. Google, same-origin, four times slower CPU:
  total blocking time in the ten seconds after the search box shows 3.4 s
  to 1.9 s (native 0.9 s), the worst keystroke delay 0.89 s to 0.68 s; at
  full speed 0.20 s to 0.15 s and 0.17 s to 0.11 s. CNN's loading task 2.9 s
  to 0.9 s (prewrite suite: a page of classic, module, strict and template
  scripts, a style and a script copied from its own markup runs as natively
  with rewrite workers and without, the worker's rewrites are the ones in
  the page when there were workers, and unless SKIP_TIMING a page with 1 MB
  of inline scripts has its longest task at most two thirds as long; 85 ms
  against 895 here).
- `XMLHttpRequest`'s credentials work as natively. `open()` stored the
  password as the user and both went nowhere, and a URL's own credentials
  were dropped, so a request to a site that challenges came back 401. The
  user and password (or the URL's) now reach the worker with the request
  and answer the site's HTTP Basic challenge once, never before it; what
  succeeds is kept for the realm and sent ahead with later requests under
  the same directory, of any kind, as the browser's auth cache does, and a
  page's own `Authorization` header is left alone. `responseURL` shows the
  credentials, as natively. Pages and workers, async and sync (xhr-parity
  suite, which compares the Authorization the site received for each
  request with the native load's).
- The document an `XMLHttpRequest` gives (`responseType` `document`, and
  `responseXML` of an XML response) is the one the browser makes: the
  realm's own XMLHttpRequest reads the response's bytes from a data: URL of
  its final type, where `DOMParser` used to parse the decoded text. Its
  charset now comes from a meta or an XML declaration (a windows-1252 page
  had a UTF-8 document with mojibake in its title), any XML type gives a
  document (an RSS or Atom response was a failed request with status 0,
  `DOMParser` refusing the type), XML that does not parse gives `null` (it
  was a `parsererror` document), and `readyState`, `title` and the rest
  follow. Its `URL`, `documentURI` and every node's `baseURI` read back the
  response's URL, and a link in it (`a`, `area`, `link`) resolves against
  that, as natively, where they all said the page's URL (xhr-parity suite).
- An `XMLHttpRequest` `blob` response of an HTML type holds the bytes the
  site sent. It was built with the page's `Blob`, which wraps HTML in the
  inject's shell for blob: documents, so its size and contents were the
  shell's (1224 bytes for a 68-byte page; xhr-parity suite).
- An XML response to `XMLHttpRequest` with no charset in its type is read
  in the encoding its XML declaration names under the default response type,
  as natively (`responseText` of a windows-1252 feed was mojibake). The
  `text` type keeps UTF-8, as natively (xhr-parity suite, pages and
  workers).
- `XMLHttpRequest` steps through its states as the browser's does (pages
  and workers, xhr-parity suite). `open()` fires `readystatechange` (for a
  synchronous request too) and starts over: a request in flight is dropped
  without events, and the last response's status, headers, body and
  request headers are gone, where they used to carry over to the next
  `send()`. `response` is `''` for a text type and `null` for the others
  until the body is there; `LOADING` and `progress` come with the body's
  bytes (an empty body has neither, as in Chrome); `responseText` under
  another type throws an `InvalidStateError` (it was a plain `Error`); a
  `json` response is parsed again on every read, as Chrome does. A document
  that set a response type or a timeout before `open(..., false)` gets the
  browser's `InvalidAccessError` from `open()` instead of a synchronous
  request, and a worker ignores the type `document`, which it has no
  documents for.
- A worker's synchronous `XMLHttpRequest` keeps its `timeout`, as natively:
  past it `send()` throws a `TimeoutError` naming the URL, with no event,
  `readyState` 4 and status 0. The timeout was ignored and `send()` waited
  for the site however long it took (xhr-parity suite, against a response
  five seconds away; the suite's other synchronous cases set a timeout no
  load comes near, where 10 ms used to time the native worker out on a busy
  machine).
- The `in` operator no longer finds the proxy's helpers:
  `'$s$j' in window` and `key in window` for the access API's or the
  client's name (a deployment's own names too) were true, natively false,
  and so on `self` and `globalThis`. The
  rewriter hands every `in` whose key is not a literal, or is a helper's
  name, to the access API's `has`, which answers as `Reflect.has` already
  did and otherwise is the operator itself (its TypeError for a primitive
  included). A page's own object with such a key answers natively, by `in`
  and by the reflective asks: an object with the stand-in tag's name used
  to be taken for a stand-in. The rewrite costs nothing measurable (the 46
  MB corpus, 13.7 s before and 13.8 s after, the median of five, within
  the noise); an `in` with a computed key costs about 2 ns more.
- `Error.prepareStackTrace` reads `undefined`, as natively, where it was
  the proxy's stack formatter: by `typeof`, `in`, `hasOwnProperty`, its
  descriptor and Error's key lists, on Error and on TypeError and every
  other constructor that inherits from it. The page's `Error` is a Proxy
  over the realm's own, which V8 reads the formatter off; the formatter
  tells the two readers apart by receiver, so stacks stay clean while the
  page sees only its own property. A formatter the page sets runs on
  cleaned call sites, reads back as itself, is an own enumerable property
  and deletes as one; deleting the proxy's (which made every stack after
  it name the routes) deletes nothing. `new Error()`, `instanceof Error`,
  `Error.prototype.constructor`, `Object.getPrototypeOf(TypeError)` and
  `Function.prototype.toString` behave as natively; `instanceof Error`
  takes about 55 ns where it took 4. A page that makes the property
  non-configurable replaces the formatter (its realm's stacks are no longer
  cleaned), and one that freezes Error sees the accessor (tells suite, both
  modes, compared with the page loaded natively).
- An error thrown by code the proxy rewrote has V8's message for the
  page's expression: `o[k] is not a function`, `location.foo is not a
function`, `o[k] is not a constructor`, `top is not iterable`, `Cannot
destructure property 'a' of 'o[k]' as it is undefined.`. V8 names the
  failing callee or value by printing it back from the code, which was the
  access API's (`$s$j.get2(...).x is not a function`, a tell that also
  reached sites' error reporting), or the message of the helper's own apply
  ("Function.prototype.apply was called on undefined"). A call,
  construction, iteration or destructuring of a value a helper made is now
  the access API's too, and fails naming the page's expression printed the
  way V8 prints it (src/callPrinter.ts) in the words of the running V8 (a
  real failure of the same shape on a marker expression), with the page
  realm's TypeError and a stack without the inject's frames or the
  rewriter's write arrows. Fixed on the way: `o?.[k]()` and `o?.[k].x` with
  `o[k]` undefined threw nothing, `o[k]?.()` with `o` null threw nothing,
  and `top = v` in strict code of an isolated frame threw a SecurityError
  naming a helper key. Left: a tagged template whose tag a helper reads,
  and `a?.b[k]` with `a.b` undefined (error-messages suite, 132 cases, both
  modes, a worker and an about:blank child, against native; the same on
  Chrome 156). Over the 46 MB corpus 44 of 98 scripts rewrite differently
  (0.1% more output; the rewrite takes as long, within the noise); in a
  proxied page `o[k].f(i)` costs 11.6 ns where it cost 10.2, a call whose
  arguments do work (`o[k].f(r.x)`, the lazy form that reads the method
  first) 28.5 where it cost 12, and nothing else moved beyond the noise.
- A large Closure module bundle is rewritten across the rewrite workers too.
  The split knew webpack's module table only, and YouTube's 10 MB
  kevlar_base (and its 2.7 MB player, and Google Docs' bundles) was one
  worker's work: 2.5 s on the critical path of every first visit. A bundle
  whose largest statement calls a function (directly or with `.call` or
  `.apply`, an arrow too) is cut into runs of that function's statements, a
  try block too large for one run (each Closure module is one) giving runs
  of its own; each run is rewritten on its own inside a function and a
  block between two marker statements, under the same strictness, and the
  outputs replace placeholder statements in the rewritten skeleton. A run
  that comes back unrewritten (the rewriter's fallback for what it cannot
  parse) makes the whole be rewritten instead, never stitched in, and an
  async function or a generator is not split. The result is byte for byte
  the whole's rewrite (checked on YouTube's two bundles, five Google Docs
  bundles and the suites' fixtures). The pool now sends a script to the
  worker with the least script in hand rather than the fewest scripts, a
  split's largest parts first: by count, one worker got two of
  kevlar_base's 2.5 MB parts while another had two small ones. A first
  visit to YouTube through the proxy shows its content after 4.4 s instead
  of 5.1 s, the watch page its video after 3.0 s instead of 3.4 s
  (split-rewrite suite, both shapes: a 2000-function Closure bundle with
  statements a line break ends and function declarations in its blocks runs
  as natively split across four workers, and whole with one; rewriter-unit:
  a Closure bundle and a sloppy one split in 2 and 4 are the whole's
  rewrite byte for byte).
- A script kept in the rewrite cache costs the worker almost nothing to
  serve. Its key is now a digest of the body's bytes as they came, and a hit
  goes out as the store's Blob: the worker no longer decodes the origin's
  body, re-encodes it to hash it, decodes the kept output into a string and
  encodes it again for the page (YouTube's bundle is 10 MB in and 20 MB
  out). Every rewritten body is encoded once, natively, and its length
  taken from the bytes: counting it in JS took 0.2 s for that bundle alone.
  The rewrite cache's write no longer holds up the page either (a match for
  the same key waits for it). On a warm YouTube load the worker's own time
  went from 0.88 s to 0.47 s (rewrite-cache-bytes suite: a UTF-8 script
  with a byte order mark and two-, three- and four-byte characters runs
  the same rewritten and from the cache, byte for byte the same body, its
  Content-Length its own).
- Inserting nodes costs the page far less in the hooks. Every element of
  every subtree inserted into a connected tree had its prototype swapped
  twice so its attributes could be read and offered to the attribute hooks;
  each insertion asked twice whether a missing parent was a `<style>`
  through a getter that threw a TypeError for it, and learned whether a node
  was an element by trying a `querySelector('*')` on it (two more swaps).
  YouTube stamps Polymer templates by the thousand: those three were 0.6 s
  of its main thread on a warm load. An element none of whose attributes a
  hook watches is now passed over after a native read of its attribute
  names, non-nodes are answered without the exception, and the node's type
  says what interface it has (insert-cost suite, both modes: a page that
  stamps a template of 250 elements 100 times and then inserts a
  DOMParser's link gets the link routed and reading back as written, and
  unless SKIP_TIMING stamps in at most 8 times the native time; it took 15
  times, 75 ms against 5, and takes about 2).
- A document that asks again for a script or stylesheet the worker just
  gave it gets the same output, without the worker fetching, reading or
  rewriting anything again. A rewritten body goes out no-cache, and Chrome
  never revalidates for a page a service worker controls: it asks again in
  full. So every script and stylesheet the preload scanner fetched while
  the parser was held up was fetched again when the parser reached it, and
  on YouTube each of them, its 20 MB bundle and 3 MB stylesheet among them,
  went through the worker twice per load (natively the document reuses what
  its scanner fetched). The worker keeps what it gave each document for 30
  s (64 MB in all) and answers the same request of the same
  document from it; never a navigation, nor a request that bypasses caches.
  The host's rules changing drops it (preload-reuse suite, both modes: a
  no-store script fetched by the scanner and again by the parser reaches
  the origin once and is rewritten once).
- A stylesheet is parsed with its values, at-rule preludes and selectors
  left as text, and only a piece that could hold a URL (a url(), a string in
  image-set() or src(), an @import, an escape) is parsed in full where it
  stands. The full parse of every value was nearly all of a rewrite:
  YouTube's 3 MB stylesheet, with one url() in it, took 2 s, in the service
  worker, where it held up every other request of the page, on every load
  (stylesheets are not kept rewritten); it takes 0.13 s. The output is byte
  for byte the same (142 stylesheets of twelve sites compared). YouTube's
  home page through the proxy paints first after 1.5 s instead of 5.1 s and
  shows its content after 5.7 s instead of 9.1 s (3.6 s instead of 7.0 s on
  a second visit). rewriter-unit checks every shape a URL comes in and,
  unless SKIP_TIMING, that a large sheet with one url() rewrites in under
  three quarters of the time a full parse of it takes (about 0.45 here).
- The rewrite cache keeps a rewritten script of up to 48 MB, 512 MB in all.
  An entry could be 8 MB at most, which never kept Discord's 13 MB bundle,
  and since a rewritten script carries its text for its functions' sources
  it kept no script of about 4 MB or more either (on Google Docs, five of
  its seventeen scripts were rewritten again on every visit). It still keeps
  300 entries at most; past 512 MB the oldest go first, each entry's size
  kept with it (rewrite-cache suite: an 11 MB output is a miss, then a hit
  byte for byte).
- A function the page defines reads back as the page wrote it.
  `Function.prototype.toString` and `String(fn)` showed the rewriter's
  output (`$s$j.get(location, 'location')`, its own spacing), a tell, and a
  broken page where the source is used: Google's sign-in button on Pinterest
  puts a click listener's source in its `gsi/button` frame's URL, and the
  frame answered 400. Every function the rewriter prints now carries a mark,
  a comment right after the first token of its source
  (`function f/*k.s.l*/(`, an arrow's after its first parameter, a method's
  after its key), naming the script's text and the function's place in it;
  the mark is the first thing in the function's own source, so nesting never
  confuses it. The text is kept once per script: by the inject for what it
  rewrites (inline scripts and modules, handler attributes, eval, new
  Function, string timers), and for what the service worker rewrites
  (external scripts, modules, workers, split bundles, rewrite-cache hits) in
  a comment inside a function the script hands the access API first
  (`$s$j.src(key, subs, function(){/*text*/})`, on line 1, its line breaks
  and `*` swapped for characters the text does not hold), read through the
  native toString when one of its functions is first read, so the page keeps
  no copy beside the script's own source. What the page hands `$s$j.src`
  itself changes nothing: a key with several holders believes the one whose
  text hashes to it. A handler's function
  (`function onclick(event) {\n...\n}`) reads back with the attribute's
  code. Every form reads back byte for byte as natively: declarations,
  expressions, arrows, async functions and generators, classes with static
  blocks and private methods, methods, getters, setters, computed and quoted
  keys, CRLF lines and raw line separators; bound, native and Proxy
  functions and the proxy's own wrappers keep their native strings. A worker-rewritten script grows by its
  own size (three.js: 614 KB rewrote to 678 KB, now 1,338 KB, of which 46 KB
  are marks; a 12.9 MB bundle to 28.1 MB, 1 MB of marks), the rewrite takes
  about 2% longer (three.js 121 to 124 ms, the best of 21; the marks are
  placed from the list the pre-pass already builds, and the key and the kept
  text cost 18 ms and 23 ms on 12.9 MB), and a split bundle is still its
  whole's rewrite byte for byte (function-source suite, both modes, against
  the page loaded natively; rewriter-unit checks the fixture's every form and
  three.js's 1,436 exported functions in node).
- A hidden frame of another site runs no animation frame callbacks until it
  is shown, as in Chrome. LinkedIn's sign-in page (one of its two variants)
  threw "Cannot read properties of undefined (reading 'Db')" from Google
  Sign-In's button library: the page keeps a second Sign-In button in a
  `display:none` layout, and Chrome holds the `requestAnimationFrame`
  callbacks of a frame cross-origin to the main frame while it is not
  rendered, so natively that button's frame never measures it. Through the
  proxy every frame is same-origin with the page, so the callbacks ran, the
  unrendered button measured 0 wide, and the library's retry
  (`setTimeout(this.u, 50)`, an unbound method) threw. In a document of
  another origin than the proxied top (a sandboxed opaque one too), a
  callback that comes due while its frame, or a frame it is in, has no box
  is now parked, and the parked callbacks run in one animation frame, in
  order, once the frame is shown; `cancelAnimationFrame` still cancels one by
  the id the page was given (hidden-frames suite, against the page loaded
  natively, both modes). Whether a frame is rendered is followed by an
  IntersectionObserver on each frame element, so a call only reads a flag:
  a cross-origin game frame's rAF loop under a parent that relayouts every
  frame costs what it did before (0.66 ms of in-frame work against master's
  0.74, frame intervals equal).
- Inline SVG holding a `<style>`, inserted into a page, no longer throws
  "Illegal invocation" from the page's `appendChild`, `append`, `innerHTML`
  or `insertAdjacentHTML` (Wikipedia, about one load in six). The insertion
  hook found the SVG `<style>` with `querySelectorAll('style')` and read its
  sheet through HTMLStyleElement's getter, which throws on any other kind
  of element. Each kind of style is read through its own accessors, and an
  element of another namespace that is only named `STYLE` is no style.
- The CSS in an SVG `<style>` loads through the proxy. An SVG `<style>` in
  an HTML page applies to the page like an HTML one, but only HTML ones
  were routed: its `url()`s and `@import`s loaded straight from the site
  in 11 of the 16 ways a script can put the text in (svg-style suite; the
  CSSOM's `insertRule` was routed already). Its text is now routed before it lands,
  as an HTML style's is, and reads back as the page wrote it. An SVG
  `<style>` in the page's own markup was replaced by a script that could
  not put it back (the parser makes a script inside SVG an SVG one, which
  has no `document.currentScript`), so it was missing from every proxied
  page; it is kept, its text routed.
- An element of another namespace named `TEMPLATE` (an SVG one made with
  `createElementNS`, or in an XML document) no longer throws "Illegal
  invocation" when its markup is set or an ancestor's is read, and no
  longer stops an XHTML or SVG document from loading. The template hooks
  went by the name alone; they now take HTML templates only, which also
  keeps an XHTML document's own `<template>` content (its name is
  lowercase there, and the copy of the page dropped it).
- Proxied requests look like the Chrome that runs them on the network
  (docs/fingerprint.md). Through epoxy the TLS ClientHello, the HTTP/2
  SETTINGS, window, priorities and pseudo-header order and the field order
  are Chrome 152's: JA4, JA3n, peetprint, the Akamai HTTP/2 hash and JA4H
  equal native Chrome's, where rustls's hello, hyper's SETTINGS and an
  alphabetical field order stood out before. The epoxy build patches rustls
  (`chrome_hello`: GREASE, Chrome's suites and extensions, ALPS, a GREASE
  ECH), adds X25519MLKEM768, brotli certificates and deflate and zstd
  bodies, and h2 and hyper patches carry Chrome's HTTP/2 and HTTP/1 shape.
  The service worker hands every request to the transport in Chrome's
  order for its kind, with Chrome's Accept-Encoding, Priority (HTTP/2
  only), Cache-Control for the cache mode and Origin on module scripts; a
  transport that does not declare `fieldSupport` (libcurl) keeps its own
  Accept-Encoding and gets no Priority. stomp-h3's QUIC ClientHello and
  transport parameters are Chrome's QUIC ones too (same rustls patch, a
  quinn-proto patch; JA4 equal to Chrome's). libcurl's TLS and HTTP/2 are
  unchanged (a rebuild of libcurl.js with BoringSSL is planned in the doc).
- YouTube's watch page no longer kills the tab ("Aw, Snap!", error code 4).
  Chrome (152 to at least 159) crashes the renderer, a CHECK in
  `cc::draw_property_utils::CalculateDrawProperties`, when a view transition
  that captures the root runs in a frame whose viewport forces a scrollbar
  with nothing to scroll; at the top it animates. YouTube's body is
  `overflow-y: scroll` and it starts a transition on every page load, and
  the proxy frames every page. In a frame, a transition that could hit the
  bug is skipped (the update callback still runs; `ready` rejects as for
  any skipped transition): checked when it starts and when the update is
  done. Cross-document transitions are skipped in frames, since the next
  document's styles are not known when they start. The test suites now can
  draw scrollbars (`launch(args, { scrollbars: true })`): Playwright hides
  them in headless mode, which hid this crash.
- A URL attribute set to an object is the string the object reads as, and
  one that reads as `''` loads nothing, as natively. The `setAttribute` hook
  kept the object and compared it with `''`, so an object whose string is
  empty passed for a URL and resolved to the document's own: an `<img>`
  fetched the page again as an image. YouTube's logo did that on every watch
  page (Polymer hands `setAttribute` such a value), a second GET of
  `/watch` with an image's headers that natively never happens
  (stringified-urls suite: the page is requested once in both modes, empty
  values stay empty, an object that reads as a path loads that path).
- A proxied WebSocket ends as a native one does. A connection that fails
  (refused, a TLS handshake that ends) fires `error` and then `close` with
  1006; the transport reports the error only, and the page waited for a
  close that never came. `close()` without a code reads 1005 (no status),
  not 1000, and a close with a code or a reason comes back with both, where
  epoxy never answered it and the page waited for good (the event now comes
  once the server had half a second to answer). `readyState` is `CLOSED` in
  the close event. epoxy reports every close the server starts as 1000
  (it never reads the frame); its own reason, "Closed by remote", no longer
  reaches the page (websocket-close suite, both modes, against native).
- Mixed content is enforced as Chrome 152 does it, by the proxied page's
  own URL (src/mixedContent.ts). Every proxied page is https or loopback in
  proxy URL space, so the browser's own check never fired and an https site
  loaded http scripts, frames and fetches that Chrome refuses (browserleaks'
  TLS page reported "Mixed Content Loaded"). On an https page, or under an
  https proxied top, an http or ws URL that is not potentially trustworthy
  is now: upgraded to https for an image, audio or video (a failed upgrade
  is a network error, never a fallback; an IP address or localhost host
  loads as is, with Chrome's warning), and blocked as a network error for
  anything else: scripts, module scripts, stylesheets and `@import`, fonts,
  preloads of active types, prefetches, srcset and picture candidates
  (Chrome's image set, which it blocks), frames (the navigation is
  cancelled, the frame keeps its document), objects and embeds, fetch, XHR
  (synchronous too), EventSource (which fails for good), beacons
  (`sendBeacon` answers false), a worker's fetch and `importScripts`, and
  WebSockets (the constructor throws Chrome's SecurityError). A form that
  targets http is warned about, cancelled in a nested frame and stopped at
  Chrome's "Form is not secure" interstitial at the top (Send anyway, Go
  back). `upgrade-insecure-requests` in the page's CSP header or meta, or
  its parent's, upgrades every insecure request it makes, frames,
  navigations and WebSockets included, whatever its own scheme; the worker
  strips the page's CSP, so it applies it. The console gets Chrome's own
  "Mixed Content" messages, naming the page Chrome names, and an upgraded
  image's `currentSrc` reads https. The service worker decides from the
  request's destination and its client's real URL; the inject decides only
  what never reaches it (WebSocket, sendBeacon, synchronous XHR, an object's
  or embed's copy). The mixed-content suite runs the same fixture natively
  and in both modes from an https page and from an http one (no
  restriction) and compares each load's outcome, the requests the two
  fixture sites get and the console's messages; its sites need a TLS host,
  which the demo reaches through a test-only transport
  (`STOMP_TEST_TRANSPORT=1`, demo/public/test/mixed-transport.mjs).
- Markup a page sets parses in the element's own context, as the
  browser's fragment parser does. `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `setHTMLUnsafe` and a shadow root's `innerHTML`
  parsed every string as the body's content: a `<tbody>`'s rows lost their
  `<tr>` and `<td>` (only the text was left; browserleaks' tables ran their
  cells together, and its ECH table lost the tabs between them), an
  `<svg>`'s children were HTML elements, a `<textarea>`'s or `<title>`'s
  markup became elements, a `<colgroup>` got no columns, a cell's
  `outerHTML` left text. `outerHTML` does nothing without a parent and
  throws Chrome's NoModificationAllowedError under the document; `null`
  sets nothing. The insertAdjacent methods take the position in any case
  (`beforeEnd`), `insertAdjacentElement` returns the element (or null with
  no parent) where it returned nothing, `insertAdjacentText` into an empty
  element no longer adds a text node reading "undefined", `afterend` no
  longer writes the next sibling to the console, and a bad position, a
  missing parent or a non-element throw Chrome's errors (fragment-context
  suite, both modes, against native).
- `outerWidth`, `outerHeight`, `screenX`, `screenY`, `screenLeft` and
  `screenTop` read the browser window's, as in any frame natively. They
  were the frame's inner size at 0,0: a window with no toolbar
  (`outerHeight === innerHeight`), which a real one never is outside
  fullscreen and which fingerprinting scripts take for headless
  (browserleaks' JavaScript page showed it; window-geometry suite, both
  modes, with real windows: Playwright's viewport emulation makes a
  native page's outer size its inner one too).
- A frame sandboxed without allow-scripts keeps its inline styles. The
  shell writes the page with each `<style>` held in a small script that
  puts it back, and in such a frame only scripts with the inject's nonce
  run: that script had none, so every inline style was lost, with a CSP
  error in the console (browserleaks' rects frame lost its positioned box).
  It carries the nonce now (sandbox-styles suite, both modes, against
  native).
- A `url()` or `@import` that no URL parser takes no longer logs a
  TypeError to the page's console ("Failed to construct 'URL': Invalid
  URL", seven on browserleaks' features page); it is left as written and
  loads nothing, as natively (css-invalid-urls suite).
- A cross-origin `fetch` or XHR GET sends Origin after Accept, where
  Chrome's network stack puts it; the worker put it first, as Blink does
  for a module script or a crossorigin image (browserleaks' HTTP/2 page
  showed it; field-order suite, a recorder of field names on another
  origin, both modes, against native).
- With HTTP/3 on (the live demo), requests carry Chrome's Priority field
  again. The HTTP/3 wrapper declared no field support, so the host dropped
  Priority from every request, over HTTP/3 and HTTP/2 alike (browserleaks'
  IP page showed it missing); it now keeps it when its base does
  (fields-unit suite).
- `localStorage` and `sessionStorage` work in a srcdoc frame. Its inject
  resolved the proxy's own storage route against the frame's location,
  `about:srcdoc`, and every call threw "Failed to construct 'URL':
  Invalid URL" (an imgur ad script). A document a worker controls resolves
  the route against the proxy's scope where its location resolves nothing.
- A frame the page removed no longer stalls a synchronous call made through
  its realm. Sentry and rrweb on discord.com take functions from a hidden
  iframe they remove at once, and pages keep a removed frame's `localStorage`
  or `document` the same way. The synchronous bridge sent the request from
  the bundle's own document but waited for the answer in the cookies of that
  realm's document, which has no browsing context and reads "": the service
  worker answered in milliseconds and every cookie read, storage call and
  synchronous XHR through that realm spun to the bridge's limit (10 s, 30 s)
  and threw RangeError. The answer is read in the bundle's own document, and
  the removed frame's `document.cookie` reads "" and ignores writes, as
  natively (removed-frame suite). Its storage and synchronous XHR still
  answer where natively they throw SecurityError and NetworkError.
- A `style` attribute on an SVG, MathML or other non-HTML element in a
  frame no service worker controls throws nothing. The copy of an inline
  style's loads read the element's declaration through HTMLElement's
  getter, which throws "Illegal invocation" on any other kind of element
  (imgur's ads, in a written about:blank frame). Each kind's own getter is
  used, and an element with no declaration has nothing to copy.
- A frame of another site no longer reaches the page that frames it through
  a fresh about:blank frame of its own. The blank frame's realm ran nothing
  of the proxy until a read the inject mediates injected it, and a literal
  name (`frames.x`, a bare `x`) or a native copy of the window's children is
  no such read: the blank's native `parent` and `MessageEvent.source`
  getters handed over the framing page, and its native eval ran code where
  `top` is the browser's, from which a walk of `top`'s frames found the
  framing page's document. A frame that stays on about:blank (no src,
  srcdoc or data of its own) is now injected as it connects, as reading its
  contentWindow injects it: from the insertion hooks and the markup setters,
  from the preamble of every parser-inserted inline script (the parser runs
  it inside the write that made the frame) and from a document observer; a
  walk of the window's children, so it costs the number of frames. A frame
  on its way to a document is left to that document's own shell, since the
  browser keeps the Window for a document of the same origin and it would
  otherwise run the parent's client (eight suites measured that). A client a page injected into a frame's initial
  about:blank, which the document of the frame's src then keeps, posted to
  a window through the bundle's own `postMessage`, of the injecting page's
  realm, so the browser named the framing page as the message's source; it
  posts through its window's own now (window-references: the six
  about:blank paths, the new evaluator ones included, as natively in both
  modes; helper-seal: the blank's evaluator reaches nothing).
- A page's stack formatter that hands off to the one installed before it
  no longer throws. `Error.prepareStackTrace` reads as the proxy's own
  formatter, where natively it is undefined, so Notion's, which calls the
  previous one when there is one, called it the way it calls everything
  (the error as `this`, the call sites the one argument), and it threw
  "Cannot read properties of undefined (reading 'length')". A call that
  does not come from V8 now gets the default text and never reaches the
  page's own formatter, which would call it again.
- Inserting a node never calls a getter the page defined on the node
  itself. The insertion hooks swap in the native prototype to read
  `isConnected` and `nodeType`, but a getter on the instance shadows the
  prototype and ran with its chain gone: YouTube's
  watch page puts logging getters on its Polymer elements, and
  `appendChild` threw "Cannot read properties of undefined (reading
  'toLowerCase')". The hooks and the script readback now call the
  browser's own getters on the node.
- A proxied page can no longer reach another site's window through the
  proxy's own globals. The client on every window held the real windows the
  inject works with (its `parent`, its `top`) under the fixed name `$P$s`, so
  a frame of another site read `$P$s.parent.document` and had its framing
  page raw, in both modes; and the access API handed out the native eval
  (`$s$j.evalSnapshot`), which ran a page's code unrewritten, where `top` is
  the real one (in same-origin mode the host page and every proxied
  window). The client now lives under a name each controller mints (16
  random characters) unless the host sets `names.client`, which publishes
  it. A page that learns the name anyway (a frame of its own site shows it
  in its shell while it loads) reads nothing by it: the access API answers
  `undefined` for it, the rewriter routes a mention of it like one of `top`
  (members, bare identifiers, object patterns with a computed key, in code
  made at run time too), and reflection gives it no descriptor. The rewriter
  asks the access API whether a direct `eval` is the real one
  (`$s$j.isEval`) instead of being handed it. Measured with a new
  helper-seal suite (both modes, with and without the framing page reading
  the frame before the child arrives): on the previous build the child
  reached its parent through the client, by the default name and by the
  learned one in ten ways, and through `evalSnapshot`; now through none of
  them. A fresh about:blank frame's native eval, reached by a literal name,
  still sees the real top (a known limitation below). The rewrite cache
  leaves the minted name out of a page script's key unless the script
  mentions it (a worker's preamble always names it), so a host that keeps
  its controller's id across a reload still gets the outputs it kept
  (rewrite-cache suite).
- An `<object>` showing an HTML document loads that document's relative
  images, scripts and stylesheets. Chrome sends no object load through a
  service worker, so the document is a blob: copy the worker controls
  neither, and its loads went to the proxy origin's own server, which
  answered 404: three things stood in the way. A blob: document was not
  taken for one no worker controls, so its loads were not made as copies;
  its own markup was written without the care markup a page writes gets
  (a script is copied at once, or it never runs; the rest after the write,
  and again once the parser is past a script it waited for); and the copy
  of a script asked the controlled page's synchronous bridge through a
  class of its own bundle, which a blob: document's bundle is not. Its
  XHRs went to the proxy origin's server too, unnoticed while its scripts
  never ran: an XHR of a document no worker controls now goes through the
  nearest controlled page, as fetch() already did (object-resources suite,
  both modes, against the page loaded natively; inline-documents).
- An error message names the page's URL right whatever the codec key. The
  xor codec's text may end in `:digits`, and the error-text cleaning took
  that for a line and column, decoded the rest to another URL and put the
  digits back after it: `?ms=3009` read back as `?ms=30:1`, now and then,
  with the key a controller drew. Where a route ends is now told by where it
  stands: in a stack frame its location ends in `:line:column`, in a message
  a URL has none (unroute-unit suite, with a pinned key that always ends the
  route in `:digits`).
- A large response body reaches the service worker as fast as the
  transport has it. A body crossed from the transport's worker as a
  transferred ReadableStream, which moves one chunk per round trip between
  the two threads, and epoxy hands out 16 KiB chunks: Discord's 12 MB main
  bundle was about 800 round trips, and while the page's 500 other requests
  filled the service worker's task queue each one waited behind them. The
  worker took 1.3 s to read the bundle (about 10 MB/s) where epoxy had all
  of it in 0.4 s. A body now travels on a port of its own: the transport's
  side reads it as it arrives, sends what came within one task as one
  message (its buffer transferred), and keeps up to 4 MiB ahead of the
  reader, which grants more as it reads, so a reader that stops still stops
  the transport and a cancelled body still cancels it. Discord's bundle is
  read in about 0.5 s (median of 8 loads of discord.com/login through a
  local demo, against 1.3 s); through the holyWisp edges about 1.0 s against
  1.5 s, the rest being the edges' throughput (4 to 6 MB/s through
  Cloudflare). Bytes cross wisp compressed (`gzip`, `br`) and are decoded
  once, in epoxy's wasm (large-body suite: 12 MB plain, gzip and br arrive
  byte for byte with the origin's Content-Encoding and Content-Length as
  natively, a cut-short body fails the read, a cancelled one closes the
  origin's response, an unread one resumes; measure-large-body times each
  layer and a reader with a busy task queue: 4.4 to 5.5 s before, 61 to
  73 ms now).
- A large webpack bundle is rewritten by every rewrite worker at once.
  One script was one worker's work, and Discord's 13 MB main bundle took
  three and a half seconds in one while the page waited for it. A minified
  page script of 512 KB or more in a shape the split recognises (webpack's
  runtime, an IIFE declaring its module table, or a chunk pushing one) is
  cut into a group of modules per worker; the groups are rewritten side by
  side and put back together byte for byte as one rewrite of the whole
  makes it (checked on all 10 scripts that split among 46 MB of Discord's,
  CNN's and Docs' scripts; Docs' are not webpack bundles). Discord's
  login is ready in about 6.0 s through a local demo against 6.7 s. The
  request log says `pool split` (split-rewrite suite; rewriter-unit suite:
  byte identity, and the shapes not split).
- A BigInt literal stays a BigInt in rewritten code. Escodegen prints a
  BigInt only from its raw text, which the rewriter's parse does not keep, so
  `0n` came out as `0`, a Number: arithmetic with BigInts threw a TypeError,
  `typeof` said "number", and a large one such as `0x9e3779b185ebca87n`
  lost its value to rounding. Discord's scripts had 93 of them. Each BigInt
  literal now carries its value as text, including one a rewritten
  expression carries along (`location = 7n`); every other kind of literal
  already kept its value (literals suite, both modes, against the page
  loaded natively; rewriter-unit suite, each kind).
- A page no longer reaches another proxied site's window raw on most of the
  ways the browser hands out a window. Every proxied site shares the proxy's
  real origin, in isolated mode too (that mode keeps the host apart, not one
  proxied site from another), so the browser's own cross-origin checks never
  fire between them and the page must get the restricted stand-in. Measured
  with a new window-references suite (a child of another site, a sibling, a
  frameset frame, an object, an embed, an SVG document, popups; every path
  compared with the same pages loaded natively, both modes), 60 paths per
  mode handed out the other site's raw window or document. Literal index
  reads (`frames[0]`, `window[0]`, `self[0]`, `top[0]`, `parent.frames[1]`,
  and the same in eval, Function bodies, handlers, `javascript:` URLs, `with`
  blocks and modules) are rewritten like computed ones; reflection
  (`Reflect.get(window, 0)`, `getOwnPropertyDescriptor(s)`, `Object.values`,
  `entries`, `assign`, `Array.from`) restricts what it reads off a window; a
  child read by name (`frames.kid`, `window['kid']`, a bare `kid`, the named
  properties object) is restricted by an accessor the child's name puts on
  its parent's `Window.prototype`; `window.open('', name)` of another site's
  frame, a window whose next document is of another site (`window.open(url)`,
  a frame's `contentWindow` read while its `src` loads) and `getSVGDocument()`
  no longer come back raw. A stand-in now names its children
  (`parent.sibling`, as natively) and answers `opener.top` with its own top.
  In the other direction a frame of another site could read the page that
  framed it: a fresh about:blank frame of its own, reached by index or name,
  ran no Stomp, and its native `parent` and `MessageEvent.source` getters,
  called on its own window and messages, answered raw. Such a child is now
  injected first, as reading its `contentWindow` does. What stays open is in
  Known limitations.
- A script is rewritten about a seventh faster. Two of the rewriter's walks
  allocated per node: the pass that moves destructured parameters into the
  body went through a generator for every node, and the main walk built a
  list of key and node pairs before it made each child's context. Both loop
  plainly now. Over 46 MB of Discord's, CNN's and Docs' scripts the rewrite
  takes 9.6 s against 11.2 s, with the output byte for byte the same; Discord
  waits on its 13 MB main script's rewrite.
- A large stylesheet is rewritten in time linear in its length. Each url()
  the rewriter routed was spliced into the whole text, so a stylesheet's
  rewrite was quadratic in its size times its url()s: CNN's front page
  inlines 3 MB of CSS with 600 url()s, which took about 5 s of the page's
  main thread, and CNN was ready in 11 s through the proxy against 1 s
  natively. The edits are collected and applied once; CNN is ready in about
  5 s, the output byte for byte the same (css-scale suite, both modes: four
  times the stylesheet takes about twice as long to write, not sixteen).
- A frame the page sandboxes is restricted as natively, and a frame without
  allow-scripts runs no script of the page at all. The proxy dropped the
  page's `sandbox` attribute (an opaque origin's navigations never reach the
  service worker, and without allow-scripts the inject could not run), so a
  frame a page sandboxed to contain untrusted HTML (webmail showing a
  message, an editor's preview, an ad slot) ran every script in it, with the
  site's storage, cookies and parent. The real attribute is now the page's
  flags plus allow-same-origin and allow-scripts, without the top
  navigation flags, so the browser keeps enforcing forms, popups, modals
  and print, downloads, pointer lock, presentation and orientation lock,
  for the frame's own frames and its popups too, and from the next
  navigation on when the page changes it. What the browser no longer
  enforces, the inject emulates from the page's value (kept in the frame's
  marker), the parent's sandbox and a popup's opener's:
  - Without allow-scripts the document gets a Content-Security-Policy (a
    `<meta>` the inject puts in before any of the page's markup is touched)
    that lets only the inject's own scripts, carrying its nonce, run. In
    Chrome 152 it blocks inline, module and external scripts, event
    handlers, javascript: URLs, eval and string timers, survives the
    `document.open()` a written page goes through, and is inherited by the
    about:blank, srcdoc, blob: and data: documents the page makes (the
    inject's shells for them carry the nonce); a frame inside it starts
    with the same decision. An about:blank the parent writes into is
    guarded as soon as the sandbox is set, a javascript: URL never
    navigates such a frame, and an XML document has its scripts, handlers
    and javascript: URLs taken out (the policy needs an HTML head).
    Noscript content shows as natively; in a document that runs scripts it
    stays text (every proxied page used to fetch the images inside its
    noscript blocks).
  - Without allow-same-origin, localStorage, sessionStorage,
    `document.cookie`, IndexedDB and Cache Storage throw Chrome's
    SecurityError, `frameElement` is null, the parent's `contentDocument`
    is null and `contentWindow.document` throws, every other window is
    restricted like one of another origin both ways, and a fetch or
    XMLHttpRequest goes as an opaque origin's: `Origin: null`,
    `Sec-Fetch-Site: cross-site` and no cookies for `same-origin`
    credentials (the inject marks it with `x-stomp-opaque`, which the
    worker strips).
  - A sandboxed document navigates only itself, its descendants, the
    windows it opened and the proxied top under allow-top-navigation (with
    user activation under allow-top-navigation-by-user-activation), and
    gets Chrome's SecurityError for anything else: the window it navigates
    runs its own inject, and the browser takes that navigation for the
    target's own. A target=_top link it may follow navigates the proxied
    top; one it may not is left to the browser, which refuses it.
  - Without allow-popups the host's `onOpen` is not asked; without
    allow-popups-to-escape-sandbox the popup is the browser's own window,
    started with the opener's sandbox, never a host tab.

  The token list the page reads (`iframe.sandbox`) holds its own value,
  and a nested frame's new-tab link reaches the host's `onOpen` (the host
  takes requests from its frames' own windows only, so it went nowhere).
  sandbox-restrictions suite, compared with the pages loaded natively in
  both modes, with a fixture beacon for every script vector of a frame
  without allow-scripts that must never arrive: 231 of 494 checks failed
  before, every script vector ran in every such frame.

- CSS text a script puts into a `<style>` loads through the proxy however it
  gets there. chess.com fills its board's style with `innerHTML`, and through
  the proxy the board and every piece loaded straight from its image host,
  past the service worker (a blank board where the network refused it). Only
  `textContent`, `innerText` and an appended Text node were routed, and those
  only after the browser had parsed the raw text: their url()s were fixed in
  the CSSOM before the next style recalc, but an `@import` was already
  fetched. Text is now routed before it lands, for every way in: `innerHTML`
  and `setHTMLUnsafe` on the style (its markup is its text), `append`,
  `prepend`, `replaceChildren` and a Text's `before`, `after` and
  `replaceWith` with strings or Text nodes, `data`, `nodeValue` and
  `textContent` of a Text in the style (whose setters routed nothing: the
  check they called needed a parent they never passed), and `appendData`,
  `insertData`, `replaceData` and `deleteData`, made to the text as the page
  reads it so its offsets hold (`style-text` suite, compared with the page
  natively, both modes: 11 of 14 ways bypassed before). A rule's `cssText`
  reads its url() as the browser serialises it (`url("...")`) whatever quotes
  the page wrote, and text routed twice keeps the page's own url() token.
- `innerHTML` replaces every child an element had. The hooked setter removed
  the old children while iterating the live `childNodes` list, which skips
  every other node, so they stayed next to the new markup: a list whose
  items are separated by whitespace kept every old item, and
  `ul.innerHTML = items` appended where it should replace (a template's
  content too; `markup-replace` suite, all 10 checks failed before, both
  modes).
- Error surfaces read as natively: none names a route, the proxy origin, an
  inject bundle or a helper name, in pages and in dedicated, module and shared
  workers (`error-surfaces` suite, compared case by case with the page loaded
  natively, both modes; 58 of 142 checks failed before). The browser's own
  messages keep their text with the route in them read back as the page's URL:
  `ErrorEvent.message` and an `onerror` handler's message (a worker's own
  `onerror` too, whose source named the route), a DOMException's message
  (importScripts' NetworkError), a failed `import()`'s TypeError (rejection,
  `unhandledrejection`, the console). An uncaught error the browser located in
  the inject (a hook called the API that threw, as for an importScripts the
  worker could not load) is placed at the page's call, from its stack; a
  dedicated worker tells its Worker object where, in a message ahead of the
  browser's report. A cross-origin classic script's error at the window reads
  "Script error." as natively (every route is same-origin to the browser,
  which never muted one). A URL that does not parse goes to the native
  `fetch`, `Worker`, `SharedWorker`, `importScripts` and `WebSocket` (which
  also refuse a bad scheme and a fragment), whose own error replaces the one
  `new URL` threw. `new Worker` and `new SharedWorker` of a script of another
  origin throw the browser's SecurityError instead of starting it. The
  cross-origin frame stand-ins throw the browser's messages ("Failed to read a
  named property ..."), and every SecurityError the inject throws has a
  stack. Stacks drop the frames of the inject's realm-made helpers (under
  every script of the page's markup) and of the bundle a module worker
  evaluates, name the page for scripts of its markup (they run inside the
  document.write that loads it), take the first line of a browser error
  without the call Blink prefixes later, read a `new Function` frame as
  `eval`, and leave out a frame name V8 inferred from the rewriter's code.
  Reporting API reports name the page's URLs. Left as they are: source
  positions of rewritten code, a page's CSP (not forwarded, so no violation
  fires), resources the page's markup loads listed twice in resource timing.
- A body the worker rewrites says its own length. A document's shell, a
  rewritten script (from the rewrite cache too) and a rewritten stylesheet
  went out with the origin's Content-Length, which counted the origin's
  bytes: a 2367-byte shell said 1137. Chrome reads such a body to its end
  anyway, but anything that reads the header saw a length that was not the
  body's. A rewritten body now carries its own byte length, a HEAD of a
  route that rewrites carries none (what the GET would send is not known),
  and a body passed through keeps the origin's length, as natively
  (content-length suite, both modes).
- An about:blank frame its creator reaches into before it loads no longer
  hooks the creator's elements. Such a frame runs the creator's bundle, and
  the property hooks for a link's `rel` and `as`, an element's `style`, a
  video's `poster`, `target`, `formTarget`, `formAction` and a form's
  `method` were keyed on that bundle's free constructors, so each frame put
  its hooks on the creator's prototypes, and its own stayed native. The
  frame's client, which no worker controls, then made blob: copies of the
  creator's own loads: Google Docs builds three such frames and sets its
  module preloads by property, so every kix module preload became an unused
  blob: copy, each module was fetched two or three times, and each
  `el.style` read went through three extra layers of hooks (200k reads took
  900 ms, now 265 ms; the editor is ready about 0.6 s sooner on a cold load).
  The hooks now go on the frame's own prototypes (blank-creator suite, both
  modes).
- A cookie write no longer throws once the page's own beacons fill the
  quota. weather.com sends analytics beacons and then writes a cookie;
  through the proxy each `document.cookie = x` was a synchronous beacon to
  the service worker, the page's beacons share Chrome's 64 KiB of beacons in
  flight per document, and the write threw QuotaExceededError ("The
  synchronous bridge cannot carry this request to .../cookies/set"), where
  natively it never throws. A write the bridge cannot carry (or one past the
  budget storage writes keep under the quota) now goes to the worker with
  fetch, numbered so the worker applies a document's writes in order, and
  every later write of the document follows it while one is in flight. The
  worker hears of the write when its request arrives, and every read of the
  jar (a request's Cookie header, a page's document.cookie, a WebSocket
  handshake) waits for it, so a fetch the page makes in the same task carries
  the cookie. The document applies the write to what it knows of the jar at
  once, so its next read sees it, and a read the bridge cannot make answers
  from that instead of throwing (cookie-beacons suite, both modes; every
  write threw before).
- postMessage from an opaque or about:srcdoc document no longer throws, and
  a frame sandboxed without allow-same-origin posts as natively. The hooked
  postMessage named the sending realm's `location.origin` as the target
  origin of the proxy's own delivery; that reads "null" in an about:srcdoc
  document (and in any document the browser made opaque), and Chrome threw
  "Invalid target origin 'null'", as LinkedIn showed. The delivery now names
  the receiver's real origin as the browser has it (the proxy origin every
  proxied window shares, an about:srcdoc or about:blank child's inherited
  one), "*" for a receiver the browser made opaque, and the proxy origin for
  one the sender cannot reach, so the message still reaches nothing outside
  the proxied world; whether the page's own target origin lets it through is
  judged by the real origins as before. The proxy drops a frame's sandbox
  attribute (an opaque document is out of the service worker's reach), so a
  frame sandboxed without allow-same-origin, and every frame inside one, is
  now opaque to the page as natively where messages are concerned:
  `self.origin` and the `event.origin` of its messages read "null", "/" from
  it reaches only itself, and a target origin naming a site never reaches it
  (sandbox-messages suite, both modes; 12 of 17 checks failed before).
- A media element's `currentSrc` and `src` read the page's own object URL.
  SoundCloud and YouTube Music attach a MediaSource through an object URL
  and read `currentSrc` back as `blob:http://<proxy>/<id>`, where natively
  it is `blob:<page origin>/<id>`. The page's form of a blob: URL was mapped
  from the proxy's by origins kept once per inject bundle, and an
  about:blank frame the page reaches into runs the page's bundle, whose
  `location.origin` reads "null": set from it, every object URL the page
  minted afterwards (and so `src` and `currentSrc`) came out in the proxy's
  form. The proxy's origin is now the realm's own as the browser has it
  (an about:blank child's inherited one), as is the one error stacks are
  cleaned of. `new Audio(url)` routed its URL into the
  element's real attribute, so its `src` and src attribute read a blob: URL
  in the proxy's form too; the URL now goes through the element's `src`
  property as the page would set it (media-blobs suite, both modes; 18 of
  29 checks failed before).
- A worker the page terminates at once no longer reports an import of the
  proxy's. A proxied worker imports the inject bundle (and a blob: worker the
  private URL of its script) before the page's script runs, and Chrome reports
  an import a terminated worker was still loading as an error event on the
  Worker. Cloudflare's challenge on Stack Overflow starts a blob: worker and
  terminates it a moment later, so through the live demo it threw "importScripts
  ... failed to load" naming `/stomp/injectWorker.js`, where natively nothing
  is reported. Those errors now stop at the worker's first listener; an
  import of the page's own that termination cuts off still reports. Measured
  with the `worker-terminated` suite (22 and 20 error events in the two modes
  before, 0 natively and after).
- A storage write sent asynchronously no longer waits for one that already
  landed. The worker applies a document's asynchronous writes in order and
  forgot the document once none was left, but the page names the oldest
  write it has in flight, which includes one that landed until its busy main
  thread runs the answer. Discord writes a large value and writes again
  while it renders, so the next write waited 10 s for nothing, every read
  meanwhile waited 3 s for that write, and a reload in that time read the
  write as missing: its login page took 23 s to render instead of 8 (2.8 s
  natively). The worker keeps each document's place for five minutes after
  its last write (storage-turns suite, both modes).
- A proxied frame may ask for storage access. The default frame sandbox
  had no `allow-storage-access-by-user-activation`, so a frame's
  `document.requestStorageAccess()` was refused for the sandbox ("The
  document is sandboxed", reCAPTCHA's anchor asks), with or without user
  activation; it answers as natively now. Every proxied frame is the proxy
  origin's to the browser, so in a profile that blocks third-party cookies
  a frame of another site is granted what natively it would have to ask the
  user for (storage-access suite, both modes, against the page loaded
  natively: hasStorageAccess, and requestStorageAccess without and with
  activation).
- A request carries the browser's Accept-Language, no empty Cookie header,
  and a WebSocket handshake the browser's Pragma and Cache-Control. The
  browser's network stack adds Accept-Language after the service worker, so
  no proxied request had one, and sites served their default language (and
  could tell); the worker now writes it from the user's languages as Chrome
  does (`en-US,en;q=0.9`), and the controller puts it on a page's socket
  handshake with `Pragma: no-cache` and `Cache-Control: no-cache`. A request
  for which the jar had no cookie went with `Cookie:` and nothing after it,
  which the browser never sends (request-header-parity suite, both modes,
  every header compared with the page loaded natively for a navigation, a
  script, an image, a fetch, an XHR and a WebSocket handshake).
- reCAPTCHA loads through the proxy. Two bugs stood in the way, both about
  frames a page makes. A proxied frame's `window.name` always read empty
  (the shadow that hides the name the host gives its own frame applied to
  every frame), so a frame looked up by name was missing: reCAPTCHA's
  challenge frame finds its anchor as `parent.frames[name]` and threw
  "Cannot read properties of undefined (reading 'postMessage')". Only the
  host's frame has the shadow now; a frame or popup the page made keeps the
  name it was given. And a page that reads an iframe's `contentWindow` at
  once gets the initial about:blank, which the parent's bundle injects; the
  browser keeps that Window for the document of the frame's src, and the
  client stayed on it, as the parent realm's code. Its messages went out
  with the parent as their source and its document took the parent's URL
  on its deferred write, so reCAPTCHA's anchor answered its own page and the
  widget timed out. The client now delivers messages and writes the
  document from the window's own realm (frame-reuse suite, both modes,
  against the page loaded natively).
- A page that replaces `Reflect.apply` never sees the proxy's messages. The
  function that posts a message from a window's own realm was made on the
  first message and called the window's `Reflect.apply`, so a page that had
  replaced it got the native `postMessage`, the window it posts to and the
  message. It is made with the client now, before any page script, over the
  bundle's own copy, and the document write that loads a page takes its
  timer the same way (frame-reuse suite: each child replaces
  `Reflect.apply` before it posts, and its replacement is never called).
- A WebSocket handshake goes out as the browser's does, once the epoxy
  build from `deploy/epoxy/` with the new patches is published and pinned.
  epoxy wrote the whole socket URL as the request-target
  (`GET wss://host/path?query HTTP/1.1`, from hyper's connection-level
  client), and servers that take no ws(s) scheme there refuse it: Akamai,
  in front of TikTok's `im-ws.tiktok.com`, answered 400 "Invalid URL" to
  every handshake, through any header, protocol or Origin. The
  request-target is origin-form now. The handshake also dropped a
  non-default port from `Host`, sent User-Agent twice (the client's and
  the caller's), sent none of the `Pragma`, `Cache-Control` and
  `Accept-Encoding` Chrome sends, joined the protocols without a space, and
  its wss ClientHello offered no ALPN (Chrome offers `http/1.1`); the page's
  `WebSocket.protocol` was always `""`, whatever the server chose. All
  fixed in the transport, with Chrome's header order (ws-handshake suite,
  reading the raw handshake the fixture received, both modes, against the
  page loaded natively).
- A classic script's `var` binding of location outside any function routes
  like one at the top level: in a block, an `if`, a `try`, a labelled
  statement, a `for` initialiser, a `for (var location of urls)` or
  `for (var location in o)` head, and as a rest element
  (`var [...location] = a`). Each assigns the window's location natively
  and navigated past the proxy. The declaration's initialiser is now
  rewritten like any expression too (`var { location } = top.o` read the
  raw top), and `var { location = d } = o` keeps its key
  (location-writes suite, both modes; rewriter-unit).
- A location that an assignment pattern or a loop head writes navigates
  through the proxy: `[location] = [url]`, `({ location } = o)`,
  `({ a: location = d } = o)`, `[...location] = a`, `for (location of urls)`,
  `for (location in o)`, and the member forms (`[top.location] = [url]`,
  `({ a: window.location } = o)`, `for (frames[0].location of urls)`, of
  `parent`, `opener` and `document` too). The rewriter took those targets
  for bindings and left them raw, so the frame navigated to the site
  itself, past the proxy, from page code, eval, `Function`, string timers,
  inline handlers, javascript: URLs and modules alike. Such a target is now
  the `value` of an access-API reference whose setter routes like
  `location = url` (`ref1`, which assigns the name in the page's own scope)
  or `x.location = url` (`ref2`). A member target named `top` or `eval`, or
  any computed one, stays a plain reference; in an object pattern or a loop
  head it was a `get2` call, which made the script a SyntaxError
  (location-writes suite, both modes; rewriter-unit).
- `location ||= url` and `location ??= url` assign nothing, as natively (a
  location is always set). The access API's `set1` navigated to whatever
  the operator left, which was the location itself: the page reloaded, and
  forever when the write was in its own script. It now navigates only when
  the operator assigned (location-writes suite, both modes).
- An `<embed>`'s or `<object>`'s resource goes out as the browser loads
  it: `Sec-Fetch-Dest: embed` or `object`, `Sec-Fetch-Mode: navigate`. The
  proxy loads it as a copy in every document (a fetch, handed to the
  element as a blob: URL), and the site saw a fetch (`empty`, `cors`). The
  copy names the load in the proxy's load header now; the worker takes
  `navigate` for those two destinations only, and decides everything a
  navigation changes from the real request's mode (blank-load-metadata
  suite, both modes, against the page loaded natively; WPT fetch-metadata
  element-embed's sec-fetch-dest passes, its entry is off the expected
  list).
- FedCM is unavailable to a proxied page, as in a browser without it.
  `navigator.credentials.get({ identity })` (Google One Tap, seen on Stack
  Overflow and TikTok) makes the browser itself fetch the identity
  provider's `/.well-known/web-identity`, its config and its accounts
  endpoint, from its own process and never through the service worker: the
  user's real Google cookies went straight to Google with a client id that
  names the real site (measured in same-origin mode; isolated mode's frame
  lacks the `identity-credentials-get` permission, so Chrome refused it
  there before fetching). The proxy cannot route those requests, so a page
  now reads as in Chrome with `--disable-features=FedCm`:
  `IdentityCredential`, `IdentityProvider`, `IdentityCredentialError`,
  `NavigatorLogin` and `navigator.login` are gone, and an identity request
  rejects with `NotSupportedError: FedCM is not supported.` (after the same
  dictionary TypeErrors and an aborted signal's reason). Sign-in libraries
  fall back to their iframe or popup flow, which goes through the proxy.
  Every other `credentials.get` (passwords, federated, WebAuthn) goes to
  the browser as before (fedcm suite, both modes, against a top-level page
  with FedCM off and against the page natively in a frame shaped like each
  mode's).
- `localStorage` and `sessionStorage` writes that fit the native quota store,
  and only those. Discord's persist store writes several medium JSON values
  in one task; each small write was a synchronous beacon to the service
  worker, a JSON value is escaped twice into it (a 20 KiB one took about
  50 KiB), and Chrome refuses a document's beacons once 64 KiB of them are in
  flight, which frees only some time after the task. So the second value
  threw `QuotaExceededError`, and so did nearly every write in the tasks
  right after. The bridge now counts its beacons in flight, and a write that
  would take them past a budget under the quota goes with the asynchronous
  path large values took, which keeps room for reads. Those writes are
  numbered and sent at once, the worker applies each document's in order
  and answers any other call after the ones that arrived, so a page that
  reloads in the task of its last write reads every value back. A write
  past 5 MiB of keys and values per origin (Chrome's quota, in UTF-16 code
  units) throws `QuotaExceededError` as natively; through the proxy nothing
  was ever refused. A value of about 700 KiB or more never read back: the
  answer rides in cookies and Chrome keeps about 180 per host. Values are
  read in parts of 256 KiB now (storage-quota suite, both modes).
- A large `localStorage` write reads back after a reload on a slow machine.
  On CI the 2 MiB write of storage-quota was missing after the reload (35
  keys against native's 36). Besides the 10 s wait for a write that landed
  (above), which held the last write back about 9 s, the worker learned of
  an asynchronous write only once its body had been read, so the reloaded
  page's first read could answer before a 2 MiB body was. The worker now
  learns of each write from its URL (sender, number, key) when the request
  arrives, and every other call of the origin waits for the ones it knows
  of, up to 6 s. A write whose body never arrives, or is not applied by
  then, is logged and its key emptied, so no document reads the value it
  replaced as current; it is still stored if it lands later (storage-quota
  suite, both modes, now also with every write's body read 2.5 s late and
  with one never arriving).
- A JSON or CSS module loads as what it is. Every import was routed as a
  module script and rewritten, so a JSON module that also parses as a
  script (`{}`, an array) came back with the module preamble
  (`import.meta.url = ...`) and failed to parse as JSON, and its whole
  module graph with it. An import's `with { type: 'json' }` now routes the
  module as it came, `type: 'css'` as a stylesheet. A dynamic
  `import(url, { with: { type: 'json' } })` lost its options in the rewrite
  (the code generator drops them) and was refused as a script: the import
  stays the page's own now, with its options, given the routed URL
  (json-modules suite, both modes, against the page loaded natively; WPT
  fetch-metadata script-json-module-import-static passes, its entry is off
  the expected list).
- A worker started from a blob: URL that the page revokes at once starts.
  Pages revoke the URL right after `new Worker(url)`, which the browser
  allows: it resolves the URL when the Worker is constructed. The proxy
  starts a blob: worker from a bootstrap of its own that imports the
  page's script inside the worker, a moment later, and found it revoked:
  the worker failed to load. The worker hook now resolves the URL at
  construction too, to the Blob the page minted it for, and the bootstrap
  imports a private URL of that Blob. The page's revoke stays native and
  immediate: its own fetch of the revoked URL fails at once, and a URL
  the worker imports after the page revoked it fails, as natively
  (blob-worker-revoked suite, both modes, against the page loaded
  natively, classic and module workers).
- A script from a blob that the proxy has nothing to rewrite in runs as a
  classic script. The page's script blobs are rewritten when it makes them,
  and one that came back unchanged was taken for one that does not parse as
  a classic script and rewritten again as a module: its preamble
  (`import.meta.url = ...`) made a `<script src=blob:>` or a classic worker
  fail with "Cannot use 'import.meta' outside a module". It is a module now
  only when it does not parse as a classic script (blob-scripts-plain
  suite, both modes, against the page loaded natively).
- A navigation a page starts in another browsing context carries its
  Sec-Fetch-User. Setting an iframe's or frame's src, submitting a form into
  a named popup or frame, and clicking a link into one navigate a context
  whose own navigate event, if it fires at all (an initial about:blank
  fires none), says nothing about the page's activation; the worker sent no
  Sec-Fetch-User even when the user's click started it, and a no-referrer
  link into a frame went out as `Sec-Fetch-Site: none`. The page now tells
  the worker itself, with its own activation: from the src hook, from every
  link click and from a form's submit event, the destination a GET
  submission builds from the form's data (navigation-initiator suite, both
  modes, against the page loaded natively). `form.submit()` fires no submit
  event and still sends none.
- An optional chain that short-circuits evaluates nothing after it through
  the proxy either. A computed member in a chain (`a?.b[k]`) becomes an
  access API call, and its key and a call's arguments were evaluated as that
  call's arguments before the API could see the chain had ended: Discord's
  login page renders `t?.messages[s.current % t.messages.length]` with `t`
  undefined, which threw reading `t.messages` and left the page blank. A key
  or an argument that does work now goes in an optional call
  (`$s$j.lazy(a?.b)?.(k())`, `$s$j.method(...)?.(k)?.(...args)`,
  `$s$j.poster(w)?.(...args)`), which the browser skips as it would the
  original; a plain name or literal keeps the direct form. The rest of a
  chain past a rewritten call short-circuits too (optional-chains suite).
- A request body goes upstream with its Content-Length, as natively, not as
  a chunked upload. The worker handed the transport the fetch event's body
  stream, and epoxy sends a stream chunked whatever the page gave (a
  string, a Blob, form data, an empty body, from fetch, XHR or a beacon);
  servers that need a length refuse that, and IIS answered 411 Length
  Required to every Bing API call (search suggestions, rewards, the
  proof-of-work token). The body is read into a Blob first, which the
  browser keeps out of the worker's memory when it is large; a page's own
  ReadableStream upload now arrives whole with a length too
  (request-framing suite).
- The synchronous bridge sends the request headers it is given as a plain
  record or a list of pairs. Only a Headers of the bundle's own realm went
  through: the branch for a record tested it for `=== null`, so every
  record was dropped (the cookie and storage calls' `content-type` never
  reached the worker, which did not read it). A Headers of another realm
  (an about:blank child's) goes through too (sync-headers suite).
- A load the proxy copies for a document no service worker controls goes
  out as the load it stands for. Such a document (an about:blank frame or
  popup the page builds, a document it opened) has its elements' loads
  fetched through the proxy and handed to them as blob: copies, and the
  site saw each as a fetch: `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode:
cors`. The copy now names the load in a header of the proxy's own
  (`x-stomp-load`), which the worker strips: an image, a script (a module
  in `cors`), a stylesheet, a preload's `as`, media and tracks, a
  `crossorigin` element in `cors`, and in a copied stylesheet an @import as
  a style, a font face's source as a font in `cors`, anything else as an
  image. The worker takes only those subresource values, never a
  navigation's, and the site stays decided by the verified client, so a
  page that sends the header itself gains nothing and the site never sees
  it. The host's request rules match the real request: a rule that edits
  headers, redirects or answers sees a copy as the fetch it is, and only a
  rule that blocks sees the load it names too, so a page cannot pick up a
  header rule meant for images or scripts by claiming to be one
  (blank-load-metadata suite, both modes, against the page loaded
  natively; WPT fetch-metadata element-img-environment-change passes, its
  two entries are off the expected list).
- A media session's artwork goes through the proxy. The browser fetches
  `navigator.mediaSession` artwork itself, for its media controls, and the
  page's URL went straight to the site (YouTube's watch page, a thumbnail
  from i.ytimg.com), while a relative one read back against the proxy
  origin. Each image's `src` is now routed when a `MediaMetadata` is made or
  its `artwork` set, the service worker serves the browser's fetch, and
  `artwork` reads back the page's URLs (media-session suite, both modes,
  against the page loaded natively).
- A navigation that arrives with no referrer carries the Sec-Fetch-Site and
  Sec-Fetch-User of the document that started it. A link clicked in a popup
  opened without a URL (about:blank sends no referrer), a `rel=noreferrer`
  link or one under a no-referrer policy reached the worker with nothing to
  say who started it, and it took each for a navigation the user started
  from the host: `Sec-Fetch-Site: none`, `Sec-Fetch-User: ?1`. The document
  now tells the worker first: from the Navigation API's navigate event, or
  in an initial about:blank document (which fires none) from link
  activation, and from the location setters and `assign`/`replace`, with
  whether it had user activation. The worker takes the initiator's origin
  from the sending document's own routed URL, never from the message, so a
  document can only vouch for navigations of its own origin. Only a
  navigation with no referrer, no client and no earlier hop waits for one,
  up to 100 ms; the host's own navigation sends the host page as its
  referrer and never waits. A redirect chain keeps the initiator, the site
  and the activation of its first hop. A page's navigation under user
  activation now sends `Sec-Fetch-User: ?1` too (navigation-initiator
  suite, both modes, against the page loaded natively; WPT fetch-metadata
  element-a and element-area pass, their twenty entries are off the
  expected list).
- A request in the moment after the service worker restarts waits for its
  controller. A restarted worker knows no controller until they answer its
  revive, which takes a few hundred milliseconds (over a second when the
  controller checks first), and a routed request in that window was not
  answered at all, so it went to the host's own server: a fetch got a 404
  and a reload showed the host's error page. For three seconds after the
  worker starts, a request under an address whose controller has not
  registered is held until that controller does (another controller
  registering first does not take it over), then answered as before
  (sw-restart suite, both modes; multi-controller, two controllers, one of
  them late).
- A contextual fragment's loads go through the proxy.
  `Range.createContextualFragment` makes its nodes in the page's document,
  so an image in it loads as it is parsed, inserted or not, and the hooks
  never saw it: a cross-site URL was fetched straight from the site, past
  the proxy, and a relative one from the proxy origin unrouted. The markup
  is now parsed by the browser in an inert document, in a context element
  of the range's kind, and the nodes are made in the page's document
  through the hooks; a script in it runs when the page inserts it
  (contextual-fragment suite, both modes, against the page loaded
  natively).
- A controller shakes hands again after a service worker restart that comes
  soon after its last handshake. A restarted worker knows no controller and
  asks them once to register again; the controller ignored that request for
  two seconds after a handshake, taking it for the startup broadcast of the
  worker its own handshake had started. A worker that stopped within those
  two seconds (Chrome stops idle ones; a crash) took the registration with
  it, and its successor's only request was ignored: every routed request of
  the page fell through to the host, a 404, until a later restart. Within
  the two seconds the controller now asks the worker over its port and
  shakes hands again when it gets no answer within a second (sw-restart
  suite, both modes, the worker stopped over CDP).
- A blob: worker the service worker knows nothing about is judged as
  another site's, never as its target's own. What pages tell the worker
  about the blob: URLs they mint lives in its memory, which Chrome empties
  when it stops an idle worker (after about 30 s): a long-lived blob
  worker's next request then came from an unknown blob: client, and went out
  as `Sec-Fetch-Site: same-origin` with the target's cookies, SameSite=Strict
  ones included. It now goes out cross-site, with no cookies under
  `same-origin` credentials and none but SameSite=None ones under
  `include`. A blob worker's requests to its own page's origin lose their
  cookies after such a restart, which is the safe side of not knowing
  (blob-worker-site suite, both modes: the service worker stopped over
  CDP, then the live worker's requests compared with a cross-site request
  natively).
- A URL property reads back right when no hook took its attribute. The
  getters resolved the page's original value from the hooks' marker, and a
  value no hook took (a link's `href` before it has a `rel`) has none, so
  `link.href` read `<page directory>/null`. They now fall back to the
  attribute as written (property-order suite, both modes, against the page
  loaded natively).
- A blob: worker's requests are judged as the page that made it. The
  worker's client URL is the blob: URL, which the service worker could not
  decode to a page, so it took the request as its target's own: an
  importScripts or fetch to another site went out as `Sec-Fetch-Site:
same-origin`, and with the default credentials carried that site's
  cookies, SameSite=Strict ones included. A page now tells the service
  worker which blob: URLs it mints; the worker records each under the real
  origin of the document that told it, read from that document's own routed
  URL, never from the message, and judges the blob's worker by it: another
  site is cross-site and gets no cookie under `same-origin` credentials.
  Entries outlive `revokeObjectURL` (pages revoke right after
  `new Worker()`) and go with the document that minted them. A blob: URL
  minted inside a worker is not registered (a worker cannot reach the
  service worker) and is judged as another site's, below (blob-worker-site suite, both
  modes, against the page loaded natively; WPT fetch-metadata
  worker-dedicated-importscripts passes, its seven entries are off the
  expected list).
- A proxied page may use what its frame's sandbox does not exist to stop.
  The sandbox only keeps a page from navigating the host, but it lacked
  `allow-presentation` and `allow-orientation-lock`, so `new
PresentationRequest()` (Spotify) and `screen.orientation.lock()` threw
  SecurityError, and popups a page opened inherited the sandbox, which they
  never have natively. `DEFAULT_SANDBOX` now adds those two flags and
  `allow-popups-to-escape-sandbox` (frame-features suite, both modes,
  against the page loaded natively).
- A `<style>` in a declarative shadow root, a plain template or a
  `<noscript>` stays a style through the page load. While the written page
  is prepared, each parsed `<style>` is replaced by a script that puts it
  back with `document.currentScript.outerHTML`. In a shadow root
  `currentScript` is null, so the script threw "Cannot set properties of null
  (setting 'outerHTML')" and the root lost its styles (every Lit component on
  MDN); in a template the page found a script in `content`, and in a
  noscript the script markup became its text. cloneRawNode marks what it
  makes below a template or a noscript, and those styles keep their
  (already rewritten) text in place (html suite).
- A no-break space in a page's script, style or JSON payload reads as the
  character again, not as the text `&nbsp;`. The HTML shell escapes the
  page's markup with `entities`' `escapeText`, which writes U+00A0 as
  `&nbsp;`, and `loadHTML` decoded it at the XML level, which only knows
  `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&apos;`. Text outside raw text
  elements was parsed back by the browser, so only scripts, styles and
  noscript contents kept the entity: BBC News's `__NEXT_DATA__` handed React
  "sites.&nbsp;" where the server had rendered a no-break space, and
  hydration failed with React errors #425, #418 and #423. `loadHTML` decodes
  at the HTML level, the inverse of `escapeText` (html suite).
- discord.com no longer throws "Maximum call stack size exceeded" for every
  script OneTrust's OtAutoBlock creates. OtAutoBlock gives each one an own
  `setAttribute` and own `src` and `type` accessors that write through the
  hooked `setAttribute`. The hooks swap an element's prototype while they
  work, but an own property shadows any prototype, so the `setAttribute`
  hook called the page's own, which called the hook again. The element's own
  configurable properties that the hook prototype also has are now set aside
  while the hooks run (instance-overrides suite, both modes, against the
  page loaded natively).
- twitch.tv no longer overflows the stack while it renders, and it renders
  as many elements as natively (about 1700, was about 1500). Every
  `localStorage` and `sessionStorage` call was a synchronous beacon to the
  service worker, and Chrome refuses a document's beacons once 64 KiB of
  them are in flight. Twitch reads one flag key over a hundred times in one
  task, so the reads after that threw `QuotaExceededError`, which a native
  read never does, and its error logger, which reads a flag again, recursed.
  A document now keeps what it read and wrote while a stamp in the proxy
  origin's own localStorage is unchanged, and every write by any document
  changes the stamp, so another document's write is still read at once.
  Storage events the browser fires about the proxy origin's own storage (the
  stamps, the cookie cache's, a same-origin host's) no longer reach the
  page (storage-burst and storage-events suites, both modes).
- `new Request(url)` with a URL that does not parse against the page's (a
  relative one in a data: worker, whose origin is opaque) throws the
  TypeError Request throws natively (`Failed to parse URL from ...`), not the
  URL constructor's `Invalid URL` from inside the inject (helper-realms
  suite).
- A javascript: URL in a fresh iframe runs. `iframe.src = 'javascript:...'`
  (or the attribute, or the markup) runs its body in the frame's initial
  about:blank, which nothing injected unless the page had read the frame's
  `contentWindow`, so the rewritten body threw `$s$j is not defined` and
  never ran (adv-scripts, both modes). The rewritten URL now has the
  parent's client inject the frame first, the way reading `contentWindow`
  does; a page, or a frame already injected, has its own client and nothing
  happens (helper-realms suite).
- A blob: module worker runs. Its bootstrap was built with the page's
  `Blob`, which a document hooks to rewrite script blobs, so our own
  preamble was rewritten once more and called the access helper before it
  had loaded the inject (`$s$j is not defined`); and its static import ran
  the page's module before the preamble, so a top-level read of
  `self.location` threw the same way. The bootstrap is made with the native
  `Blob` and imports the page's module once the client is in place. Module
  workers also lost the messages posted to them at once: the browser
  dispatches them during the preamble's top-level await, before the page's
  module has set its handlers, where natively its top level runs first. The
  preamble holds them (and a shared worker's connects) and the client
  dispatches them again (helper-realms suite, against the page loaded
  natively).
- imgur.com renders (about 700 elements, as natively) instead of hanging
  its tab. Its ad sync pixels walk the frame tree from a frame of another
  origin, and both walks ran forever through the proxy, holding the main
  thread until the tab ran out of memory (the sweep saw no elements, then a
  closed browser). rubiconproject's usync climbs `t = t.parent` until it
  reaches `top`: a same-origin parent is handed over as itself, and its own
  `parent` getter answered with its own stand-in for the top, never the one
  this frame's `top` reads, so the climb went on at the top. ingage's pixel
  visits every `frames[i]` from `top`: a frame still on its initial
  about:blank runs no Stomp, and a stand-in's index read turned any such
  window into the top, so the walk went round the tree, five levels deep.
  Documents of one origin now share their stand-in for each window of
  another (a `postMessage` through one is still sent from the caller's
  realm, so the source is the caller), a stand-in's `parent` and `top` read
  the real windows rather than the context's own getters, and a child that
  runs no Stomp yet is restricted as itself (frame-walks suite, both modes,
  against the page loaded natively).
- A same-origin frame's hooked functions read as native from its parent.
  Each proxied frame loads its own copy of the inject, whose wrappers the
  parent's copy never made, so the parent's `Function.prototype.toString`
  showed a frame's `fetch`, `open`, `document.write` and `toString` as the
  wrapper's source. A function of another realm is now handed to that realm's
  own toString, whose copy knows its wrappers (function-strings suite, both
  modes, against the page loaded natively).
- A defined custom element in a template's markup is no longer
  constructed until the page stamps it. The hooks that take a markup string
  (a template's `innerHTML`, markup holding a `<template>` through
  `innerHTML`, `insertAdjacentHTML`, `outerHTML` or a written document) made
  a template's children in the page's document, so each one was constructed
  with its attributes still the page's "[[...]]" bindings, which Polymer and
  YouTube take off before they clone the template. YouTube's watch-next
  renderer read `shownItems` as the string `"[[watchNextShownItems]]"` and
  threw `E.some is not a function` on every load. A template's children are
  now made in its own inert content document, as the browser parses them.
  The copies `setHTMLUnsafe`, a shadow root's `innerHTML` and
  `document.write` build to rewrite their markup are made in an inert
  document too: made in the page's, every custom element in them was
  constructed twice (custom-elements suite, both modes, against the page
  loaded natively).
- A URL property set before the attribute that makes it a load holds the
  page's URL as written. `link.href` set before `link.rel` (YouTube's player
  loads `www-player.css` that way) was read back through the browser's
  getter and written into the attribute, resolved against the document's
  real URL, the proxy's; when the rel came, the stylesheet was fetched from
  the proxy origin and refused. The player never built: through the proxy
  YouTube's home page rendered about 1,600 elements where it renders about
  2,000 natively, `ytd-player` holding 2 of its 406. The setter now leaves
  the attribute as the page wrote it when no hook took the value, and the
  home page renders the same elements, tag for tag, as natively
  (property-order suite, both modes, against the page loaded natively).
- `fetch(request)` fetches the request's own URL, not a `url` the page
  defined on the object. YouTube checks its fetch with a `data:` Request
  whose `url` and `method` it shadows with getters naming its player
  endpoint, and expects the data back; the hook read the shadowed `url`, so
  every load sent a GET to `/youtubei/v1/player` (405) and told YouTube its
  fetch was patched. The hook reads the URL through the native getter, and
  a Request it does not route is fetched as itself (page-apis suite).
- A fetch, image, script or other load from an iframe's initial about:blank
  document sends no Referer, as natively (about:blank strips to no
  referrer); a fetch that names a referrer still sends it under the policy
  about:blank inherited. No service worker controls that document, so its
  loads go through the parent's realm, and they carried the parent's
  referrer (blank-referrer suite, both modes, against the page loaded
  natively; WPT referrer-policy iframe-inheritance-about-blank passes, its
  two entries are off the expected list).
- `document.referrer` in an iframe's initial about:blank document is its
  creator's full URL, whatever the referrer policy, as natively: it read
  empty, because the readback compared the routed referrer's origin with the
  document's location origin, which about:blank and srcdoc documents read as
  `"null"` (blank-referrer suite, both modes, against the page loaded
  natively; WPT referrer-policy iframe-inheritance-about-blank).
- A subresource whose connection fails (nothing listens, the host does not
  resolve, the connection drops before an answer) is a network error for the
  page: fetch rejects with a TypeError, an XHR fires `error` with status 0
  and a synchronous XHR throws, as on the real site. The worker answered it
  with a 500 JSON body of its own, so the page's fetch resolved. A response
  the transport received and refused to parse (hyper's header parser
  rejects a control character in a header value, which Chrome reads) still
  gets an error response (network-errors suite, both modes, against the page
  loaded natively).
- A response with one malformed header line reads as it does natively, once
  the epoxy build from `deploy/epoxy/` with the new patches is published and
  pinned. hyper refused the whole HTTP/1 response over a line with no colon,
  a space before the colon, an obs-fold continuation or a lone CR, and
  epoxy failed it over any byte past 0x7E (a UTF-8 `Content-Disposition`
  filename), so the page got the worker's error response, or a network
  error, where Chrome skips the line, joins the fold, splits the line at the
  CR and keeps the value as a byte string. A patch to hyper rewrites a lone
  CR in the head as Chrome reads it (httparse refuses it even when told to
  skip invalid lines), epoxy-tls turns on hyper's lenient header options and
  passes values through byte for byte. A NUL in the head stays fatal: Chrome
  refuses it too (measured: a network error, not the space RFC 9110
  allows), so a response the transport cannot read is now a network error
  for a subresource, like a failed connection, and the worker no longer
  tells the two apart by hyper's `Parse(` error text (malformed-headers
  suite, both modes, against the page loaded natively; wpt-cookies
  `%x0 in name (HTTP)` twice and `ignore value after LF` now pass).
- A synchronous request (a `document.cookie` read, a synchronous XHR) whose
  answer ran a character or two past a multiple of 4000 encoded characters
  threw `SyntaxError: Bad control character in string literal in JSON`. The
  worker splits the answer into cookies of 4000 and counted the chunks from
  the whole length, one short of the chunks it set past the first piece, so
  the page joined a cut answer. The split and the join are now one pair of
  functions in `src/encodeCookie.ts` and the page waits for every chunk it
  is told of. The answer's cookies also expired 3 s after the request
  arrived rather than after its answer, so an answer slower than that was
  set already expired and the page spun to its limit (sync-chunks suite, in
  node, every length up to four chunks; malformed-headers failed about every
  other run once its jar grew to that size).
- Scripts are rewritten off the service worker's thread. The service worker
  rewrote every script itself, one at a time, so a page of large scripts
  waited for each in turn (six 600 KB scripts took about a second to arrive,
  natively about 115 ms). The controller now starts rewrite workers
  (`rewriteWorker.js`; `rewriteWorkers`, default half the cores, one to
  four, `0` for none) and hands the service worker a port to each with the
  handshake; a script goes to the worker with the fewest in hand, and comes
  back byte for byte what the service worker would have made. The first load
  of that page went from about 1030 ms to about 530 ms. A worker is used
  once it says it is ready, so one that failed to load costs nothing; the
  service worker rewrites the script itself whenever no worker is ready or
  one has not answered within `rewriteTimeout` (default 10 s; that worker is
  not used again), and lets the workers go with their controller. The
  request log says where (`rewriteIn`: `pool` or `service-worker`). The
  inline scripts of an HTML document are still rewritten in the service
  worker, with the document (rewrite-pool suite).
- A script's rewritten output is kept in a cache of its own (Cache API,
  `stomp-rewrite-cache`), keyed by a digest of the body with everything the
  output depends on: the URL, the script type, the config, the codec key and
  the build. A script loaded again with the same body is answered without
  rewriting it, byte for byte the same; a six-script page of 600 KB scripts
  went from about 1000 ms to about 155 ms on the second load (natively about
  105 ms), and Chrome's extra fetches of a parser-inserted script are hits.
  It keeps only what the HTTP cache's privacy rules allow (no `no-store` or
  `private`, no Authorization, no cookie without `public`), at most 300
  entries of 8 MB (the oldest go first), and is cleared with the
  HTTP cache (`clearCache()`, a new codec key) and whenever a new service
  worker activates. `cache: false` turns it off with the HTTP cache. The
  request log says which it was (`rewriteCache`: `hit`, `miss` or `skip`)
  (rewrite-cache suite). A `no-cache` script is kept too: its body arrives
  every time and is the key, so nothing goes stale.
- A minified script is rewritten minified. The generator indented and broke
  every line, so a minified library came back up to twice its size (three.js
  614 KB to 986 KB, TinyMCE 457 KB to 876 KB): the worker spent the time
  writing it and the page reading and parsing it. Minified input (lines over
  200 characters on average) now comes back about its own size (three.js
  666 KB), its stack positions on one line as natively; code written to be
  read keeps one statement per line, so an error's line number stays near
  the page's own (rewriter-unit suite).
- Synchronous requests carry binary and non-UTF-8 bodies byte for byte. The
  synchronous bridge decoded every response body as UTF-8 in the service
  worker, and its cookie encoding could not carry a character past U+00FF,
  so a sync XHR for a font or an image (or any non-UTF-8 text), and a
  script copied through the bridge into an uncontrolled document with CJK
  text in it, arrived corrupted; storage values past U+00FF read through the
  bridge did too. A UTF-8 body now travels as its text and anything else in
  base64, and an ArrayBuffer or typed array request body as its bytes (it
  was decoded as UTF-8, and a Uint8Array was dropped). XMLHttpRequest
  decodes text as the browser does, in documents and workers, sync and
  async: the `overrideMimeType()` charset first (it did nothing, so the
  classic `charset=x-user-defined` binary read failed), then the response's
  Content-Type charset, a byte order mark over both, UTF-8 otherwise. A
  worker's synchronous XHR works (it threw; Chrome hands it to the service
  worker, so the browser's own XHR carries it), with any responseType, and
  a worker XHR with the default type has its responseText. A document's
  refusal of a responseType on a sync request is an `InvalidAccessError`
  as natively (sync-binary suite, both modes, against the page loaded
  natively).
- Typed OM writes in a document no service worker controls load through
  the proxy: an `attributeStyleMap` set, append, delete or clear now has
  its element's inline style copied as a CSSOM write is, underneath the
  hooks, so the page's MutationObserver sees only its own write. A Typed
  OM value read back (`attributeStyleMap.get(...)`, a parsed
  CSSStyleValue) showed the page's url() with its quotes escaped
  (`url(\"...\")`); it reads as the page wrote it (blank-sources suite,
  both modes, against the page loaded natively).
- Constructed stylesheets in a document no service worker controls load
  through the proxy: the url()s and fonts of a sheet the page makes with
  `new CSSStyleSheet()` and fills with replaceSync, replace or insertRule,
  adopted by the document or a shadow root, reached the proxy origin's own
  server. Once its rules change (replace: once they are in) the sheet's
  routes are copied and put back as a `<style>`'s are, a style rule
  through its own declarations, so a rule the page holds stays the sheet's
  own and the CSSOM reads back what the page wrote; the copies are the
  sheet's and are released when its rules no longer show them. An @import
  in a constructed sheet is still dropped, as natively. Copying into a
  `<style>`'s style rules failed with "Illegal invocation" (the native
  methods were handed the readback's view of the declarations), which left
  those rules with their routes; they now take their copies (blank-sources
  and blank-loads suites, both modes, against the page loaded natively,
  with the bypass recorder).
- A FontFace a page makes in a document no service worker controls loads
  its source through the proxy. `new FontFace(name, 'url(...)')` there
  fetched the font from the proxy origin's own server, so `load()` and
  `document.fonts.load` failed with a NetworkError. A face's source cannot
  change once it is made and the face fetches from the realm that made it,
  so a copy made later could never reach it: a face whose source names
  routes is made instead with the FontFace of the nearest controlled realm
  (the one routed fetches go through), keeping the document's own
  prototype, and its `loaded` and `load()` promises are the document's own.
  A face from an ArrayBuffer, and any face in a controlled document, is
  made as before (blank-sources suite, both modes, against the page loaded
  natively, with the bypass recorder).
- SVG references in a document no service worker controls load through the
  proxy: an `<image>` by href or xlink:href, a `<use>` of an external
  sprite (its fragment kept on the copy), an `<feImage>` and an SVG
  `<script href>` reached the proxy origin's own server and failed. They
  are copied like an `<img>`, and released when the element shows another
  value; an SVG script the page writes is copied at once, as an HTML one
  is. An xlink:href a hook holds back while its copy loads is set again in
  the xlink namespace, so the element still sees it, and the page's
  MutationObserver sees no record of it. getAttributeNS for a namespaced
  attribute a hook rewrote, getAttributeNames and the markup now read back
  as the page wrote them, in the order it wrote them, also for an
  attribute set again once its copy arrived (blank-sources suite, both
  modes, against the page loaded natively, with the bypass recorder).
- `document.write` and `writeln` are the prototype's methods again. The
  hook was an own property of each document, which a page could list
  (`Object.getOwnPropertyNames(document)`) and compare
  (`document.write !== Document.prototype.write`); it is now on
  Document.prototype, where the browser has it, so a popup's or a frame's
  document finds its own realm's hook and client. A hooked function of
  another realm the inject made (a popup's `write`, a frame's `fetch`) read
  through the page's own Function.prototype.toString gave the wrapper's
  source: the native source is now known to every realm of the bundle
  (written-documents suite, both modes, against the page loaded natively).
- getHTML with shadow roots the page lists serializes them as the browser
  does: an open root that is not serializable and a closed one, passed in
  `shadowRoots`, come out with the browser's own template attributes. The
  copies keep each root's flags and the browser's serializer gets the page's
  options with the copies of the listed roots, so it decides what to include
  as it would on the page's own (markup-parity suite, both modes).
- getHTML reads a page's markup back as the page wrote it. It returned the
  proxy's routed URLs and its `s_o:` markers (innerHTML and outerHTML did
  not); an element's and a shadow root's getHTML now serialize a folded
  copy in the inert document, a copy of every shadow root they would
  include (open and serializable, or listed in `shadowRoots`) attached to
  the copy of its host, and go through the CSS and script readbacks as
  innerHTML does (markup-parity suite, both modes, against the pages loaded
  natively).
- A whole document a page writes keeps its doctype and its html, head and
  body tags. Written markup was rewritten as a fragment, which dropped the
  doctype (the document rendered in quirks mode) and the attributes of the
  html, head and body tags: an editor frame lost its body's
  `contenteditable` and class. A write that opens a fresh document (just
  opened, or written once it had loaded) and starts with them keeps them,
  their attributes through the hooks as any element's; the head's content
  and the rest are rewritten as before, and a write into a document already
  being parsed stays a fragment (written-documents suite, both modes,
  against the page loaded natively).
- What a page writes into a document no service worker controls loads:
  an editor's frame (`<iframe src="">` written once it loads, as CKEditor 4
  does) and a popup its opener writes into now show the written stylesheet
  and images. The copy of each load was made on the clone the written
  markup is rewritten on, and the element the parser made had only its
  marker; now the parser's elements get their copies once the write is in
  (scripts keep the copy they got during the write). A write into a
  document that had loaded opens it again, as the browser does, and counts
  as opened (written-documents suite, both modes, against the page loaded
  natively, with the bypass recorder).
- Reading a page's markup back loads nothing. innerHTML, outerHTML, a
  shadow root's innerHTML and XMLSerializer give the page its own markup by
  copying the subtree and folding the hooks' markers back; the copy was made
  in the page's own document, where every image and media source the fold
  put back (the page's raw URLs) started loading straight from the site.
  The copy is now made in a document with no window (one for HTML, one for
  XML), where nothing loads or runs, and serializes as before
  (property-sets and blank-loads suites, both modes, with the bypass
  recorder).
- A URL property a page sets never loads past the proxy. A reflecting
  property's setter handed the page's raw value to the browser's own setter
  before the hooks routed it, so a script, stylesheet, frame, embed or
  object already in the document given its URL by property (`s.src = ...`
  after appending, `iframe.src = ...` on a frame on screen) loaded it
  straight from the site, and in a document no service worker controls an
  image or a media element did too. The value now goes into the hooks'
  view of the attribute, as with setAttribute, and only the route or copy
  they make reaches the element; `style`, which forwards to cssText, keeps
  its own path (property-sets suite, both modes, with the bypass recorder).
- A `<style>` rule the page holds stays the sheet's own while its loads are
  copied in a document no service worker controls: a style rule takes the
  copies into its own declarations, as an inline style does, instead of
  being deleted and inserted again (which detached the page's reference).
  Only @import and @font-face rules, which have no declarations to edit,
  are still put back whole (blank-loads suite, both modes).
- A frame whose sandbox the page builds through its token list loads through
  the proxy. `iframe.sandbox.add`, `.toggle`, `.replace`, `.remove` and
  `.value =` write the attribute without any attribute hook seeing it, so the
  sandbox Stomp drops stayed on the real frame. reCAPTCHA sets its anchor
  frame's sandbox, then adds each newer flag the browser supports that way:
  the frame was sandboxed with those flags alone, an opaque origin whose
  navigation skipped the service worker, and the proxy server answered its
  `html:nested` route with a 404 (seen on the TinyMCE docs through
  stomp.fracit.al). A hooked list's call now runs on a detached copy holding
  the page's value and writes the result through the page's `setAttribute`,
  so it returns, throws and shows MutationObserver records as natively and
  the page reads its full sandbox back (sandbox-tokens suite). The list's own
  reads (`value`, `contains`, iteration) still show the real, empty list.
- CSS a page writes into a document no service worker controls loads its
  images through the proxy: a `<style>`'s rules, a style attribute and a
  CSSOM write (`el.style.x = ...`, setProperty, cssText) have their url()s
  copied, and the copies are set underneath the hooks (a rule is put back
  through the CSSOM, an inline style with the declaration's own setProperty
  inside the hooks' write scope), so the page reads back its own text and
  its MutationObserver sees only its own writes. The copies are the
  element's: an inline style or a `<style>` that changes keeps the copies it
  still shows and releases the rest. Typed OM writes, constructed sheets
  and FontFace sources in such a document are not covered (blank-loads
  suite, both modes, against the page loaded natively).
- A stylesheet a document no service worker controls loads has its own
  loads copied too: its url()s, its @import (whose own url()s are copied in
  turn, four levels at most) and its fonts reach the proxy instead of the
  proxy origin's own server, and the copy reads back as the same stylesheet
  does in a controlled document (the page's token kept after each copy's
  marker). The copies go with the stylesheet's (blank-loads suite, both
  modes).
- A script the page writes (document.write) into a document no service
  worker controls runs in place, in the order it does on the real site: its
  copy is made at once through the synchronous bridge from the nearest
  controlled document, so it blocks the parser as natively, and one that
  writes the next script (an ad chain) runs that one before what follows.
  This holds with the transport in the transport worker (a
  TransportDescriptor, the default), where the bridge completes; the
  controller says so in the config (`workerTransport`). With the transport
  in the page (an instance, or `host: 'page'`) the bridge would spin to its
  limit, so there a written script still does not run: the known limit. The
  bridge is given 5 s at most, and a failure falls back to the asynchronous
  copy (blank-loads suite, both modes and both transport hosts, against the
  page loaded natively).
- In a document no service worker controls, async=false scripts run in the
  order the page added them. Each gets its source once its copy is in, and
  the browser runs such scripts in the order they get one, so a slow script
  ran after a fast one added after it. A copy is now applied only once every
  earlier async=false script of the document has had its own (blank-loads
  suite, both modes and both transport hosts, against the page loaded
  natively).
- A srcset copy that fails no longer leaves its other copies alive: every
  candidate's copy is waited for, and when one fails the others are released
  with it. The copies are made and released with the URL functions the page
  had when the proxy started, so a page that replaces them sees none of
  the proxy's.
- A copy loaded for a document no service worker controls is released once
  its element shows another value: an editor frame that swaps its images no
  longer keeps every earlier blob alive. The old copies are revoked after the
  new value is set (a media element plays the old one until then), and a
  copy that arrives after its value was replaced is released at once
  (blank-loads suite, both modes).
- Documents a page builds itself load their images, scripts and
  stylesheets through the proxy. Chrome hands an about:blank frame or popup
  no service worker, whether the page writes into its first document, opens
  it or navigates it to about:blank (measured in plain Chrome 152; a srcdoc
  frame it does), so every element load in one reached the proxy origin's
  own server and failed: the content of editors, ad slots and widgets built
  that way. In such a document (no controller, and about:blank or opened)
  an image, srcset, image input, script, stylesheet, poster or media source
  is now fetched through the proxy and given a blob: copy, written under the
  hooks; the attribute, the property, currentSrc and the markup read back as
  the page wrote them. A property set no longer writes an emptied URL back
  (a script then failed for good). The url()s inside such a stylesheet, CSS
  in style attributes and fonts are not covered yet. WPT's fetch-metadata
  element-img-environment-change no longer hangs (blank-loads suite, both
  modes, against the page loaded natively).
- A download link whose click handler stops the click's propagation still
  saves what the site serves. The proxy's copy was started from the window
  at the end of the click, which such a handler never let it reach, and the
  browser's own (broken) download went ahead. The browser's download is now
  cancelled as the click starts and the copy saved once every handler ran,
  unless one cancelled it; until then the page reads `defaultPrevented` and
  `returnValue` as its own calls left them (download suite, both modes,
  against the page loaded natively).
- A popup opened without a URL, and a new frame, read their location as
  `about:blank`. A window the page injects itself (its about:blank document
  runs the opener's inject bundle) read the bundle's own window's location,
  so `popup.location.href` and a fresh frame's `contentWindow.location.href`
  showed the opener's URL (window-identity suite, both modes, against the page
  loaded natively).
- A link with a `download` attribute saves what the site serves. Chrome
  hands no download to a service worker, so the browser fetched the routed
  URL from the proxy origin's own server: the download was its 404 page,
  named after the route, and was cancelled. A same-origin download (the only
  kind the attribute applies to) is now fetched through the proxy and saved
  from a blob: URL under the name the browser picks on the real site (the
  attribute, the Content-Disposition, or the URL's last segment); the page's
  own click handlers run first and can cancel it. WPT's fetch-metadata
  element-a and element-area pages no longer hang (download suite, both
  modes, against the page loaded natively).
- A window keeps its identity when it navigates to another site. The page
  got a window as itself while it was of its origin (the popup
  `window.open()` returned, a frame's `contentWindow` read before the frame
  loaded) and as a restricted stand-in once it was not, so a message's
  `event.source`, a later `contentWindow` and `opener` were another object
  than the one the page held: the common check `event.source === popup` (an
  OAuth or payment popup, an embed's frame) never matched, and WPT's
  fetch-metadata window-location and form-submission pages hung on it. A
  window the page already holds is now handed back as itself wherever it
  goes; that gives the page nothing it did not have (window-identity suite,
  both modes, against the page loaded natively).
- A module worker's imported modules run with the hooks in place. A module
  worker loads the client from the top of its own body, but its static
  imports are evaluated before that body runs, so a request an imported
  module made at the top level (a `fetch` built on `import.meta.url`) went
  straight to the site. Every static import of a worker module is now routed
  as a worker module, and whichever module of the graph runs first loads the
  client, once (bypass-relative and rewriter-unit suites).
- A page's `<base href>` applies to its own markup. The page loader routes
  every URL in the markup before writing it, when the base element is not in
  the document yet, so every relative URL in the page (stylesheets, images,
  srcset, media, SVG references, frames, forms, pings, inline module imports,
  the import map) resolved against the page's URL instead of its base; and
  the base's own href, and its `href` property, resolved against the base URL
  in force rather than the document's URL. The loader now resolves the markup
  against the first `<base href>` it holds, and a base's href against the
  document's URL (bypass-relative suite).
- An SVG `<use xlink:href>` with a relative URL is routed. The hooked
  `setAttributeNS` (which the page loader also uses for every namespaced
  attribute in the markup) wrote the page's value first and routed it after,
  and a `<use>` fetches its reference the moment the attribute lands: the
  relative URL was requested against the document's route, a path on the
  proxy origin that names nothing. A hooked attribute is now created empty
  and the value written through the hooks, as `setAttribute` does
  (bypass-relative suite).
- A script reads back the source the page wrote when `document.write`,
  `innerHTML` or `insertAdjacentHTML` made it, when its text was set while
  it was connected, and when it is an SVG script; each read back (and
  serialised as) the rewritten code. A script `document.write` wrote was
  even rewritten twice, so its own `document.currentScript.text` was the
  first rewrite (markup-parity, readback suites).
- Every element reads its attributes back as on the real site (found by
  the new markup-parity suite, which compares the corpus pages and the
  attribute fixtures loaded natively and through the proxy, in both modes).
  `setAttribute('HREF', x)` on an HTML element skipped the hooks (they are
  keyed by the lowercase name), so the link went out raw and read back its
  previous value. An attribute a hook drops (an object's `data` placeholder,
  an iframe's `sandbox`) was missing from `getAttributeNames()` and
  `attributes`, and serialised after the attributes written later.
  `attributes['s_o:href']`, `getAttribute('s_o:href')` and a marker name in
  capitals still answered.
- A page's MutationObserver sees the attribute writes it made, not the
  proxy's. Each routed attribute keeps the page's value in an `s_o:` marker
  next to it, and one write by the page is several native ones (the routed
  value, the marker, the property applied again), so an observer got records
  named `s_o:src` and `oldValue`s holding routed URLs, which frameworks and
  analytics read. Observers now get one record per write, named for the
  attribute, with the value the page saw before as its `oldValue`; the
  hooks' own writes (routing an inserted element) make none, `takeRecords()`
  answers the same, and a callback left with no record is not called.
  Corpus: attrs 2 failing checks to 0 (scramjet fails this one too);
  markup-parity compares every record with the page loaded natively.
- A link's ping goes through the proxy. `<a ping>` and `<area ping>` were
  not routed: a ping to another origin reached the site straight from the
  browser, past the proxy, and its Ping-From and Ping-To headers named the
  proxy's own address and routes; a relative ping was lost. Every URL in the
  attribute is now routed (the page reads it back as written) and the worker
  rewrites Ping-From and Ping-To to the real URLs. Found by the new bypass
  suite, which fires every request API and loading element in a proxied page
  and fails on any request that reaches the network without the proxy, in
  both modes (bypass suite).
- A URL property whose attribute is missing or empty reads back as on the
  real site, never as the proxy's address. A form without an action got a
  routed one the page could read (`getAttribute('action')`, `outerHTML`):
  Last.fm's pjax submits a form to `$form.attr('action')`, so its sign-in sent
  the proxy's raw URL on, which was routed again and refused (the route of a
  route is now the route, so it lands, but the page still saw the proxy). Such
  a form now keeps no action and submits to the document's own address, whose
  query a GET submission replaces as the browser would. `form.action`,
  `formAction` and `base.href` without an attribute, and an empty `href` or
  `src`, read the document's URL or its base URL, and setting one to `''`
  leaves it empty (url-defaults suite, both modes, against the page loaded
  natively).
- A route of a route is the route. A page that got hold of its own raw
  proxy URL (a read the rewriter missed) and handed it to a link, a form
  action or `location` had it routed again, and the worker refused the result
  as its own origin: a Last.fm sign-in on Fracital ended on the error page,
  kind `refused`. Every routing hook now unwraps a URL that is already a route
  of the scope (any controller id and kind, any depth) and routes the real URL
  it stands for, and the worker answers a request for a double route with a
  307 to the single route, documents and subresources alike. Only a genuine
  own-origin URL is still refused. The page reads such a link back as it wrote
  it (double-route suite, both modes).
- Documents a page makes itself load their subresources through the proxy. A
  `javascript:` URL's string, a `text/html` blob shown in a frame and a
  `data:` frame became documents no service worker controls (Chrome does not
  hand them the creator's), so their images, scripts, stylesheets, fonts and
  XHRs reached the proxy origin's own server and failed (nothing went to the
  site). They are now inline documents: the page registers the markup with the
  worker under a single-use random token (from a document of the same
  controller, at most 4 MiB, expiring in seconds) and the frame navigates to
  `<address>inline:<token>/...`; the worker rewrites the markup itself as for
  any fetched page and serves it, so the document is controlled, with the
  referrer policy its creator's navigation carries. A `javascript:` URL's
  document is a raw bootstrap that replaces itself with it. An unknown, used
  or expired token gets the error page. Readbacks are as before (a data: frame
  is origin `"null"`, a blob document shows the page's URL), and a document
  whose URL is not http(s) sends no Referer, as the spec's strip rule says. An
  `<object>` or `<embed>` document cannot be made controlled (Chrome never
  hands their loads, or their documents' own navigations, to a service
  worker): its fetches go through the page, its markup subresources and XHRs
  still miss the worker (inline-documents suite, both modes).
- A `data:` frame runs proxied, as the opaque origin it is. Its document has
  an opaque origin the inject could not reach: its requests had nowhere to go
  and its messages never arrived. A `data:text/html` frame now loads from a
  blob: URL of the shell with the data: URL as its document's URL, so it runs
  injected while every readback treats it as origin `"null"`: its `origin`,
  `location.origin` and messages say `"null"`, `location.href` is the data:
  URL, `document.domain` is empty, and the page and the frame see each other
  through the restricted cross-origin stand-ins (`contentDocument` null,
  `SecurityError` on reaching the other's document). The page never injects
  such a frame itself. This is the same best-effort footing as every proxied
  cross-origin frame in same-origin mode, not the browser's isolation.
  Requests from a document no service worker controls go through the nearest
  controlled ancestor, by each client's own parent, and without a referrer
  where the document's own default is none (data:, and the about:blank a
  `javascript:` URL's document keeps); an explicit `referrer` of the page's
  origin is sent in proxy space, so the browser honours it (data-frames
  suite, both modes; wpt-referrer-policy: the inheritance pages, 7 more
  subtests pass).
- `postMessage` honours the target origin between proxied windows. Every
  proxied window shares the proxy origin, so the browser's own check let any
  `targetOrigin` through: a message aimed at one origin reached a frame of
  another. The target is now compared with the receiver's real origin (`*`
  any, `/` the sender's own, `"null"` never matches) and an invalid one is the
  browser's `SyntaxError` (data-frames suite).
- The shell writes a blob document's URL into its first script with `<`
  escaped: a URL holding `</script>` (a data: document's markup) ended that
  script early and the document lost its URL.
- `<object data>` and `<embed src>` load through the proxy. Chrome never
  routes their loads through a service worker, so the routed URL reached the
  proxy origin's own server and the element showed nothing (a page, a PDF or
  an image alike). The inject now fetches the resource through the proxy and
  hands the element a blob: URL of it: HTML wrapped in the shell like a blob
  document (its real URL as base), anything else as it came. The element has
  no URL until then (an empty one makes an object show its fallback and stop
  loading), a value set again keeps the load in flight, a later value wins,
  and a failed fetch falls back to the routed URL. `data` and `src` read back
  as written (frames-objects suite; wpt-referrer-policy:
  `unsupported-elements`, 4 subtests from timeout to pass).
- A transport is initialised once at a time. Every port served from one
  transport (the service worker's, each page's) called `init()` for every
  request that found it not ready, so a burst at start-up initialised it
  several times at once; epoxy's `init()` loaded its wasm again on each call,
  and two same-tick calls killed the first client. All callers now wait on
  one in-flight `init()` per transport, and a failed one is not kept, so the
  next request tries again (transport-init suite).
- A frame whose document a `javascript:` URL's string makes runs proxied.
  `<iframe src="javascript:'<p>...'">` (and a link or `location` set to such
  a URL) replaces the document with the string's markup, which nothing
  injected: its scripts ran raw, saw the host as `top` and posted to it. A
  single-expression `javascript:` body now hands a string value to the
  client, which wraps it in the shell like a blob document; statements and
  other values are left as they are. Such a document is not controlled by the
  service worker, so the inject sends its routed fetches through the nearest
  controlled ancestor, and a fetch's response URL is read back through the
  client rather than the bundle's own `location` (links suite, rewriter-unit
  shape; wpt-referrer-policy: the two `javascript:` inheritance pages report
  instead of timing out).
- The cookie jar parses a line the way Chrome does. A control character
  anywhere in it (an attribute value included, `Domain=localhost\x01`) drops
  the whole cookie; only the name and value were checked, so the cookie was
  stored without that attribute. A response header reads a NUL as a space and
  ends at a bare CR or LF, as Chrome's HTTP parser reads it. An attribute
  value over 1024 bytes is skipped, so an earlier Path or Domain still counts
  (the oversize one won). A nameless cookie whose value starts with
  `__Secure-` or `__Host-` is refused, since it would pass for that cookie.
  One Set-Cookie value (or one `document.cookie` write) is one cookie: the
  parser split it at commas, so `test=1, baz=qux` lost everything after the
  comma. A cookie set again with a new value is a new creation and moves
  behind the other cookies of its path, as in Chrome (the same value keeps
  its place); a nameless cookie set again stayed first (cookie-jar and
  cookie-rules suites; wpt-cookies, with the test-driver shim fixed too:
  `attributes-ctl.sub.html` from 4 to all 423 natively passing subtests,
  the whole suite from 305 of 764 to 851 of 860).
- `document.cookie` on a document without a browsing context (one a
  navigation replaced, one from `createHTMLDocument`) reads `""` and ignores
  writes, as in a browser; it threw "Illegal invocation" because the hook
  accepted only the window's current document (wpt-cookies:
  `navigated-away.html`).
- A rewritten `x.postMessage(...)` on a null or undefined `x` throws the
  TypeError the original call throws ("Cannot read properties of null
  (reading 'postMessage')"), not "Function.prototype.apply was called on
  undefined" from inside the access API. testharness's
  `fetch_tests_from_window(window.open(...))` hits it when the host hands
  popups to its own tabs and the page gets null (rewriter-unit shape).
- Upstream servers saw Fetch Metadata describing the service worker's own
  fetch rather than the page's request. Sec-Fetch-Mode was guessed from the
  destination (`no-cors` for a crossorigin image or script, a module import,
  a font; `cors` for a `same-origin` or `no-cors` fetch), and Sec-Fetch-Site
  was `none` whenever the referrer did not name the page (a dynamic import,
  whose referrer is the inject bundle; a fetch under `no-referrer`) and
  `same-origin` at the end of a redirect that had left the site. The worker
  now rebuilds the four headers as Chrome does for the real origins: the
  mode is the request's own, the site compares the request's client (the
  document or worker, not the stylesheet or module that named the URL) with
  the target, schemefully and by registrable domain with the private
  registries, widened over every redirect of the chain (the redirect memo
  that carries the Referer to the next hop carries the site too); the
  destination is `document` for the page's top-level navigation, and `none`
  with Sec-Fetch-User is left to the navigation the user starts from the host.
  Sec-Fetch-Site no longer walks a nested frame's ancestors (the cookie
  jar's site still does), Origin follows the request's mode, an http origin
  that is not potentially trustworthy gets no fetch metadata, and a
  synchronous XHR names its document as the initiator. The headers suite
  compares each request kind with the native page's; wpt-fetch-metadata
  drops 92 expected failures. A blob: worker's requests are still taken as
  same-origin, and a navigation a page starts under user activation still
  lacks Sec-Fetch-User (the worker sees neither).
- A `Refresh` response header refreshes the page. The browser schedules a
  header refresh on the document it creates for the response, and the shell
  re-opens that document to write the page, which drops it: the page stayed
  where it was. The worker now carries the header into the markup as a meta
  refresh right after the doctype, which the inject routes like any meta
  refresh the page wrote (refresh suite; wpt-referrer-policy: the three
  `refresh-*` pages, 46 subtests from timeout or not run to pass).
- A link or `window.open` aimed at a frame of the page by name navigates that
  frame. With a host that handles new tabs (`onOpen`), every target outside
  `_self`, `_top`, `_parent` went to the host as a new tab, including the
  name of an iframe the page owns, so the frame never loaded and the host
  opened a tab instead (the WPT referrer-policy `a-tag` pages, whose links
  target a named iframe, never reported). A target that names an iframe or
  frame of the page now stays with the browser, which navigates that frame
  (links suite; wpt-referrer-policy: 111 `a-tag` subtests from timeout to
  pass).
- A proxied document's `document.referrer` follows the referring page's
  referrer policy. The browser applies the policy in proxy URL space, where
  every page shares the proxy origin, so it keeps the full routed URL, and the
  inject decoded that: a frame on another origin saw the full referring URL
  where its header, meta tag, `referrerpolicy` attribute or the default
  (`strict-origin-when-cross-origin`) said origin only or nothing. The
  service worker now hands each document it serves the referrer it computed
  for the real origins (the function the Referer header already used, moved
  to `src/referrerPolicy.ts`), and when the browser sent only the proxy
  origin (`origin`, `strict-origin`) a nested document applies the policy to
  its parent. The worker also remembers what each redirect it answered sent,
  so a chain through another origin stays narrowed on the next hop for the
  header too (wpt-referrer-policy at concurrency 1, iframe-tag, script-tag,
  xhr, img-tag and fetch: 196 proxied failures to 0; referrer suite:
  no-referrer, origin, cross-origin strict-origin-when-cross-origin and
  unsafe-url frames match native ones).
- `new Request(request)` keeps the request's URL. The Request constructor
  hook resolved its first argument as a URL string against the page, so a
  Request given a Request (what `fetch(new Request(req, init))` and libraries
  that copy requests do) asked for `/[object Request]` on the page's origin
  (Last.fm's request log showed the 404s). A Request input is now copied as
  the browser copies it; strings and URLs resolve as before (page-apis
  suite).
- A `data:` script, stylesheet or document whose body holds a `?` is rewritten
  whole. The URL parser files everything from the first `?` of a data: URL
  under `search`, and the rewriters read the data from `pathname` only, so a
  body with a query in it (`data:text/javascript,import("https://x/s.py?a=1")`,
  what the WPT referrer-policy dynamic-import pages do) was cut there, failed
  to parse and ran as written, with a SyntaxError in the page. The data is now
  everything after `data:` but the fragment (wpt-referrer-policy: the 30
  `script-tag-dynamic-import` pages, 384 subtests, from every scenario
  rejecting to all passing; rewriter-unit shape).
- A host page controlled by the host's own service worker boots. Our
  worker's startup revive (or any message carrying the `$stomp$swRevive`
  key) that arrived before the first handshake, which a descriptor transport
  delays while its worker imports the module, made the controller adopt
  `navigator.serviceWorker.controller`; on a page the host's root worker
  controls that is the foreign worker, and the handshake went there forever:
  `wait()` never resolved on live Fracital with a fresh profile. The revive
  handler now ignores a revive before the first handshake, acts only on one
  whose source is a worker served from the directory, adopts the page's
  controller only when it is one of ours and otherwise keeps the
  registration's active worker; the `controllerchange` handler already
  applied that test, and the registration lookups are scoped to the
  directory (foreign-sw suite: a host page under a foreign root worker, a
  fresh registration and a descriptor transport, broadcasts during startup
  and later; the controller stays on its worker, `wait()` resolves, a frame
  loads).
- A large `localStorage` value stores. The synchronous bridge carries a
  page's `localStorage` calls to the worker in a beacon, which the browser
  refuses over 64 KiB (and the quota is per document while the page's thread
  spins, so no number of beacons helps; a sync XHR never reaches a service
  worker in Chrome), so `setItem` with a large value (Wikipedia's) threw
  `QuotaExceededError`. A write the bridge cannot carry is now kept as the
  document's own view of that key and sent to the worker asynchronously, in
  order; the writer reads it back, lists it and can remove it at once, later
  operations on a key with a write in flight queue behind it, and other
  documents see the value once it is stored (storage-events suite: a 200 KiB
  and a 2 MiB value).
- `URL.createObjectURL` answers with the page's origin. A blob: URL names the
  origin of the realm that minted it, which is the proxy's, so every object
  URL a page or worker made (and stored, showed, or compared with
  `new URL(u).origin`) carried the proxy origin: the last proxy-origin leak
  the adversarial corpus could see, hidden until async XHR in workers worked.
  The page now gets `blob:<its origin>/<uuid>` and everything it hands the URL
  to maps it back to the browser's form (every URL-taking API routes through
  `routeURL`, which does it for blob: URLs, plus `fetch`'s direct path, the
  worker bootstrap and `revokeObjectURL`); response URLs and readback show the
  page's form. A blob: URL of another origin is left as it is and does not
  resolve, as the browser refuses blob: URLs across origins (blob-origin suite,
  both modes; adversarial-urls 12 failures to 2, adversarial-workers 2 to 0).
- A rewritten body no longer outlives the worker that made it. Rewritten
  responses (documents, scripts, stylesheets, XHR bodies, the inject shells)
  went out with the origin's caching headers, so the browser's HTTP cache
  could keep a rewritten script for as long as the origin allowed (a year for
  an immutable asset) with an old rewriter's output or old helper names in it;
  a rewriter upgrade did not reach it. They now go out `cache-control:
no-cache` with the origin's validators kept and `expires`/`age` dropped: the
  browser asks the worker again and the worker answers from its own cache of
  the upstream bytes, so a reload revalidates without an upstream request
  (measured: one upstream fetch across a load and a reload). Bodies the worker
  did not rewrite keep the origin's headers (no-cache suite).
- Reflection reaches the same spoof as a member read: `Object.getOwnPropertyDescriptor`
  and `Reflect.getOwnPropertyDescriptor` (and `getOwnPropertyDescriptors`,
  `__lookupGetter__`, `__lookupSetter__`) on a window or the document answer
  descriptors for `top`, `location` and `eval` whose accessors resolve through
  the access API (a location write routes), `Reflect.get` and
  `Object.entries` / `Object.values` resolve those values by what they are
  (so a Proxy over the window is covered), and the access API's own name is
  not enumerable and is left out of `getOwnPropertyNames` / `Reflect.ownKeys`
  of a window. `super.location` is left alone by the rewriter (it was a
  SyntaxError), and a function made with `new Function` reads back the source
  the page gave in the browser's shape. Corpus: protos 36 leaks to 0, eval 6
  to 0, in both modes.
- Scripts a page inserts or writes at runtime run rewritten in more shapes:
  the inline scripts of `document.write` / `writeln` markup; a connected
  script's `text` / `textContent` set after insertion (the moment it runs);
  a JavaScript Blob (`text/javascript` and the other JavaScript MIME types)
  loaded as a script's `src` or imported by a worker, rewritten at
  construction like an HTML blob (as a module when only that parses); a
  script appended to a connected shadow root; and every node argument of
  `append` / `prepend` / `replaceChildren` / `before` / `after` on elements,
  fragments and documents (`append(a, b)` rewrote `a` only). `Attr.value`
  and `nodeValue` writes reach the attribute hooks, a `javascript:`
  destination of `window.open` is rewritten, and `Reflect.set` /
  `Object.assign` with `location` route like an assignment.
- `document.write` / `writeln` markup is tokenized across calls, the way the
  browser's own parser reads it: a tag name, an attribute value, a script or
  style body, a comment or a textarea that one call leaves unfinished waits
  for the call that finishes it (`write('<scr'); write('ipt src=...')`, the
  shape old ad and analytics loaders use), and an element a call leaves open
  holds what the next call writes (`write('<div>'); write('x</div>')` made a
  closed div, loose text and a dropped end tag; an end tag for the element
  the script sits in closes it). Each call used to be parsed as a complete
  fragment, so a split script ran as text or threw, a split URL was lost and
  a split style never applied. `document.close()` hands the parser whatever
  is still pending, as the end of its input would.
- Markup the browser parses itself goes through our parser first:
  `setHTMLUnsafe` on an element or a shadow root (so a declarative
  `<template shadowrootmode>` gets rewritten contents) and a shadow root's
  `innerHTML`, which reads back as the page wrote it. Nodes parsed from a
  markup string stay in the parser's document until they are cloned: an
  `img onerror` from `innerHTML` / `outerHTML` / `insertAdjacentHTML` no
  longer fires once raw before the rewritten handler runs.
- A write to another window's `location` (`frame.contentWindow.location =
url`) carries its value and targets that window. An about:blank child of
  a proxied page runs its creator's bundle, whose free `location` was the
  creator's, so the creator navigated to `undefined`; the Location module
  reads the document's own `location` for the same reason. Corpus: scripts
  51 leaks to 2 in both modes; the 2 are one probe that reports the window
  `window.open('javascript:')` returns, which is the browser's own result.
- A document a proxied page writes into an about:blank child or popup runs
  its creator's bundle: the attribute hooks now install on that document's
  own element constructors (`HTMLAnchorElement` and twenty others were the
  creator's, so an anchor's `href` in a written child read back routed), and
  its location proxy takes that document's `Location.prototype`. A
  BroadcastChannel message's `origin` is the page's origin, not the proxy's.
  Corpus: frames 8 failing checks to 4 and messages 5 to 2 in both modes;
  the remaining ones report the browser's own results (a window returned by
  `window.open('about:blank')`, a probe's own source text serialised by
  `innerHTML`, a sloppy-mode detached method call that does not throw).
- A meta element's `content` property reads back what the page wrote: the
  hook treated every content as a URL and answered `<proxy>/stomp/html/null`
  for a meta the proxy never rewrote, which broke pages decoding a base64
  payload from one (GitHub's `visitor-payload`, three atob errors per load).
  A rewritten refresh reads back as written too.
- What a page reads back from its stylesheets and markup is what it wrote.
  A rule's `cssText` and `style`, a sheet's `href` (and an `@import`'s), a
  style element's text, rules inserted or constructed at runtime, a style
  attribute the browser serialised from a CSSOM write, and serialised markup
  (`innerHTML`, `outerHTML`, `XMLSerializer`) show the page's url()s and
  attribute values, never the routed ones: the rewriter keeps the written
  url() token after `#url(` and the readback restores it. A template's
  `innerHTML` folds the markers inside its content, `XMLSerializer`
  serialises a folded copy, `getAttributeNS(null, name)` and an attribute
  node's `textContent` answer like `getAttribute`. Corpus: attrs 36 failing
  checks to 2 (MutationObserver records, which show the marker writes;
  scramjet fails that one too).
- What the platform tells a page about itself names the page's URLs. An
  uncaught error's `filename` (`ErrorEvent.filename` and the second argument
  of a `window.onerror` handler) is the script's real URL; the stack of code
  run through `new Function` or `eval` no longer names the inject bundle as
  its eval origin but the page's own call site; a `Response` that came back
  from the Cache API or was cloned reads its real URL. Cache API entries are
  keyed by the page's URLs (a string key resolves against the page, `keys()`
  and matches come back as the page's, `add()` and `addAll()` fetch through
  the proxy); `indexedDB.databases()` lists the page's own databases by their
  own names and no others. Corpus: urls 22 failing checks to 12; the 12 are
  blob: URLs carrying the proxy origin (five probes) and the absent
  `navigator.serviceWorker` (a decision: pages never reach the worker).
- A worker believes it runs where the page put it: `self.location` (every
  URL part and `String(location)`) and `self.origin` are the real script URL
  for a classic or module worker, the same blob under the page's origin for a
  worker started from a blob: URL (its stack frames agree), and a shared
  worker reads its own name back without the origin the constructor hook
  appends to keep proxied origins apart. Like a document's, the stand-in is
  what rewritten code gets from the access API; `WorkerLocation.prototype`
  is untouched, and the reflection hooks treat a worker scope and its
  prototypes like a window (`getOwnPropertyDescriptor(WorkerGlobalScope.prototype,
'location')` resolves to the stand-in, the access API's name is hidden
  from `getOwnPropertyNames(self)`). Corpus: workers 10 failing checks to 0.
- The helper names the rewriter and the inject rely on (`$s$j` and `$P$s` on
  the window, `$s$L` and `$s$N` on the location and eval stand-ins) are not
  visible to a page asking reflectively: `getOwnPropertyNames` and
  `Reflect.ownKeys` leave them out, `hasOwnProperty`, `Object.hasOwn`,
  `Reflect.has` and `propertyIsEnumerable` deny them, on the window, the
  document, location and eval only (a page's own object with such a key
  answers natively). Two tells stay and are documented: the bare `in`
  operator (rewriting every `in` would cost more than it hides) and
  `Error.prepareStackTrace` being a function (stack cleaning needs it;
  scramjet carries the same).
- An optional chain stays optional past an unforgeable link: `a?.b.location.c`
  rewrote to an access-API read that threw on a nullish `a` where the page's
  code short-circuited to undefined. The rewriter now looks down the chain's
  spine for an earlier optional link (a parenthesised chain ends it, as in
  the language) and keeps the rest of the chain optional. `img.currentSrc`
  reads back the candidate the browser picked as the page wrote it.
- The service worker refuses a route that decodes to the proxy's own origin
  (403, "Stomp does not proxy its own origin", reported with `error`): the
  proxy fetching itself was a loop and a way to its host page. A fetch's
  credentials mode reaches the cookie jar the way the browser applies its
  own: `omit` sends no cookies and stores none from the response,
  `same-origin` sends them only when the initiator's real origin is the
  target's, `include` and the default send them.
- The rewriter keeps the two comments DevTools reads: `//# sourceURL=` as
  written (eval'd code and stack frames carry the name the page gave) and
  `//# sourceMappingURL=` routed against the real script URL (a `data:` map
  as it is), appended after the rewritten code; every other comment is still
  dropped with the formatting.
- `navigator.registerProtocolHandler` (and `unregisterProtocolHandler`) is
  accepted and does nothing: it would register the proxy origin, with the
  browser's prompt naming it; a bad scheme still throws. `console.clear()`
  does nothing in pages and workers: the console is shared with the host and
  carries the rewriter's warnings. The Navigation API is kept, with its URLs
  read back unrouted, rather than removed.
- `WebSocketStream` (Chrome) goes through the proxied WebSocket like
  `WebSocket` does: the URL resolves against the page, `opened` hands the
  page its readable (strings and ArrayBuffers) and writable, `closed`
  settles with the close code and reason, `close()` and an aborted `signal`
  close the socket. Only where the browser has the class, so feature
  detection stays truthful; before this a page using it bypassed the proxy.
- A script that opens with `'use strict'` stays strict: the rewriter keeps
  the directive prologue first and places the worker bootstrap and an inline
  script's `currentScript` restore after it. Both came before it, which made
  the directive a plain expression, so inline scripts and classic workers ran
  sloppy (`this` in a plain call was the window, undeclared assignments
  passed). Measured before the fix: inline sloppy, external strict, worker
  sloppy, eval strict.
- Markup written into an about:blank child frame or popup (which runs its
  creator's bundle) produces nodes of the child's own realm and document: the
  clone helper used the bundle's `document`, `DOMParser`, `Text`, `Comment`
  and `Element`, so the child's elements were the creator's and its own
  hooks never saw them. It now works in the client's document and decides by
  node type. The request report for a failure the host's error page answers
  carries no client id (the page never reports one), so the host gets it at
  once instead of after the attribution wait.
- `onRequest` and the `request` event carry the frame for a request made by
  a frame nested in a proxied page (the host's frame that shows the page),
  and report it as soon as a top-level document's. A nested document told
  the host which service worker client it is like the page does, but the
  host took reports only from the windows of its own frames, so the report
  of a nested frame's document waited out the three seconds a report gets
  for a page that has yet to say where it is, each of its fetches a second
  and a half, and all of them came without a frame: the demo's request
  viewer never showed them. Both controllers now find the frame by walking
  up from the reporting window (with the host's own `parent` getter: a
  proxied page of the host's origin answers `parent` itself). A client that
  never says still has no frame, and holds its reports back for that wait
  once instead of every time (request-frames suite).
- A worker's requests, and those of a document on about:srcdoc, carry the
  frame too, with no wait. Neither could say which client it is: a worker
  has no window to tell the host from, and an about:srcdoc document no URL
  of the proxy's to ask `whoami` at. The service worker now names the
  document that made a worker (`RequestInfo.owner`): the worker script's
  own request carries both ids (`clientId`, the creator, and
  `resultingClientId`, the worker; the same in Chrome 152 and 156, for
  dedicated, module and shared workers and a nested frame's), and a worker
  started from a blob: URL, whose script never passes the service worker,
  is matched by the URL its creator names when it asks for the worker's
  transport port. An about:srcdoc document is told its id by the service
  worker when the first request of it is reported, and passes it on like a
  page: no fetch per frame (a `whoami` took 0.4 to 2.3 ms each over twenty
  frames), and nothing at all for a frame that loads nothing or a host
  without a request log. A document on about:blank is no client: its loads
  already went out as its page's. What still has no frame is a client
  nobody speaks for, a page's emulated service worker (its site's, not a
  frame's), and it alone waits, once. Per proxied frame nothing changed:
  1063 KB of heap on Chrome 152 and 1060 KB on 156 before and after, the
  document bundle 284 bytes larger (frame-cost; request-frames gains the
  rows).
- What a controller keeps for that (which frame each service worker
  client's requests belong to, and which clients nobody spoke for) no
  longer grows with every navigation: every document and every worker is
  a new client, and nothing was ever taken out, so a tab navigated 200
  times left 801 entries, each holding its frame. An entry now goes when
  its frame went away (the host took it out of `frames`, or its element
  out of the document), when its client is gone (every sixteen new
  clients the controller asks the service worker which of those it keeps
  still exist; `RemoteController` asks through the controller frame), and
  past 1024 in any case, the oldest first. Both controllers share the one
  class (`src/controller/clientFrames.ts`). After 200 navigations of four
  clients each a controller keeps 5 clients, never more than 17 on the
  way; 85 for twenty frames become 9 once the frames are gone; a client
  that is still there (a page's service worker) is not waited for again
  (request-clients suite, which reads the counts from the controllers'
  internal `clientCounts`).
- A document in a frame of a proxied page tells the host which service worker
  client it is and when its history moved, nothing else. It ran the whole of
  what a page reports where it is with (a MutationObserver over its document,
  the icon looked up and the report built on every change, a message to the
  host whenever it differed), and the host took from it only the client id and
  that a report came, on which it reads the frame's Back and Forward again. It
  keeps `pushState` and `replaceState` wrapped and its four window listeners,
  and after any of them posts a history message once per turn. Twenty ad-like
  frames posted 40 navigate reports as they loaded (7140 bytes) and now post
  40 history messages and 20 client ids (2880 bytes); five of them changing
  their title and their document 5000 times each posted 25035 more reports
  (4.9 MB) and now post none (Chrome 152). The heap a frame costs is unchanged
  (1132 KB over 20 frames). A top-level document reports as before.
- A host hook that throws in a document nested in a proxied page reaches
  the host (`onHookError`, the `hookerror` event, `hookErrors`), with the
  frame that shows the page, like a request's. The nested document posted
  the report to the real top as the page does, and both controllers
  dropped it there with everything else a nested window says: of a `pre`
  hook throwing in a page, its nested frame, its about:blank child and its
  srcdoc frame the host heard one error, the page's, and hears four
  (realm-hooks). The report of an about:blank child's carries the
  error's message and stack like the others: the hook there throws an
  Error of the child's realm, which the page's bundle did not take for
  one (`instanceof`), so the message read `Error: boom` and the stack was
  left out. A hook that throws in a worker still tells nobody.
- The first thing a host or a page does after the service worker was
  stopped is carried through. Chrome stops a worker nothing has reached
  for 30 s, so for a page that sat idle that is the user's next click or
  address-bar navigation; a fetch already was (the worker holds it for its
  controller), these were not:
  - a host's navigation (`frame.go`, any call of the controller to the
    worker: `route`, `unroute`, `setRules`, `clearCache`, `cookies`) was
    rejected with "Service worker replaced" about 110 ms in: the call was
    waiting on the old channel when the restarted worker's handshake took
    its place. A call is made again on the channel that replaced it, waits
    for a handshake that is under way, and takes a message with it that
    starts a stopped worker (a port does not), so a call with nothing else
    to start the worker no longer waits for good. `wait()` resolves for
    the handshake under way, not for the first one.
  - the first WebSocket a page opened never opened and never failed: the
    page asks the worker for its port to the transport, and the worker
    that message started knew no controller yet and dropped it. A page's
    message for an address whose controller has not registered waits for
    it in the revive window, as a request does (an inline document's and
    a blob: URL's too).
  - sw-restart has the rows, on both controllers: a navigation is through
    219 to 260 ms after the stop (about 1.2 s inside the two seconds in
    which a revive is checked first), a bare `route()` in 113 to 119 ms,
    the WebSocket's first message in 114 to 118 ms. The synchronous calls
    (cookies, storage, a synchronous XHR) still froze the page until
    their limit after a stop (see below).
- A controller tells a restarted service worker's revive from the worker it
  has just shaken hands with at once. The revive names the run of the worker
  it is from, and the worker that takes a handshake says which run it is
  (`hello`), so a revive of another run means a handshake and one of the same
  run means nothing. Before, within two seconds of a handshake the controller
  asked the worker over its port, and a worker stopped again in that time says
  nothing: a host's navigation right after a second stop waited a second for
  the silence (1201 to 1326 ms, now 160 to 434 ms), and so did a page's first
  request after a stop that soon after a handshake (1119 to 1214 ms, now 121
  to 180; sw-restart). A worker of an earlier build, whose revive names
  nothing, is asked as before.
- The service worker is not stopped under a live controller. Chrome stops a
  service worker no event has reached for 30 s, whether its tab is visible or
  hidden and whatever the page runs or holds open (measured natively on Chrome
  152 and 156: stopped at 28.5 to 29.8 s with a visible tab, a hidden one, a 1
  s timer, an open WebSocket; through the demo at 29.7 to 32 s), and the first
  thing a page did after sitting idle paid for a worker start and a handshake.
  A controller now sends the worker a message every 20 s (`KEEPALIVE_MS`),
  timed by the transport worker, whose timers a hidden tab does not hold back
  (a controller with an in-page transport starts that worker's script for the
  clock alone), and nothing else: no request, nothing per frame, no event held
  open. sw-keepalive (new): 45 s idle under each kind of controller, the
  worker never stopped.
- A page's synchronous ask (`document.cookie`, `localStorage`, a synchronous
  XHR) first after the service worker stopped is answered, where it froze the
  page for the bridge's whole limit (10 s for a cookie or a storage call, 30 s
  for a request, then an error or status 0): the worker it started knew no
  controller, and the controller, on the thread the page spun on (the host
  page, or the controller frame in isolated mode), could not hear the worker
  ask for one. After 300 ms of waiting the page tells its controller with an
  event dispatched on the windows above it, of a type only the two of them
  know, and the controller offers the handshake from inside the page's task; a
  worker that has the controller declines the offer and nothing changes. Each
  ask is now answered in 306 to 362 ms, the 300 ms included (sw-restart, both
  controllers and an in-page transport). With the keepalive above, a worker
  stops under a live controller only with a frozen tab, a machine that slept
  or a crash.
- Slow synchronous requests to a running service worker no longer make a
  handshake offer each. Every ask that waits past 300 ms tells the controller,
  and an offer carries what a handshake does (the wasm modules, a port per
  rewrite worker), so 120 synchronous XHRs of 600 ms made 60 offers that the
  running worker turned down: 63.8 MB of module bytes copied to it and 360
  ports opened, up to 8.1 MB of the worker's memory waiting for its garbage
  collector at a time. Nothing stayed after collection but the last offer's
  port. Now an offer is never made while another is on its way (one with no
  answer in 10 s is withdrawn), the worker declines in words before it closes
  the offer's ports, and no other offer follows for 20 s after the worker that
  has the controller declined one (the keepalive keeps it running that long):
  4 offers, 4.3 MB, 24 ports, 3.0 MB at the most, no port left (sw-restart:
  one offer for ten slow requests).
- `history.pushState` and `replaceState` refuse a URL of another origin, or
  one that does not parse, with a SecurityError naming the page's origin and
  URL, like the browser; before this the URL was routed and accepted (every
  proxied URL looks same-origin to the browser, so the check is made on the
  real origins).
- A frameset's `<frame>` and an `<object>` hand the page an injected
  `contentWindow` / `contentDocument` like an `<iframe>` does (an about:blank
  frame the page writes into gets the child hooks). An HTML document in an
  `<object>` or `<embed>` still cannot be proxied: Chrome never routes their
  loads through a service worker (measured: no request reaches the worker),
  so the browser fetches the routed URL from the proxy origin directly.
- A frame nested in a proxied page of the same real origin reads its own
  `frameElement` (another origin's parent gives null, the host's frame is
  never seen), and `MessageEvent.source` follows the real origins: a window
  of the page's own origin as it is, another proxied origin's restricted
  (every proxied window shares the proxy origin, so the browser handed the
  page the whole window), anything outside the proxied world as the top.
  Known gap, measured: a same-origin child posting to its parent goes through
  the parent's own `postMessage` wrapper, which makes the parent the
  incumbent, so the browser reports the parent as the source (and the
  envelope the parent's origin); a cross-origin child posts through its own
  realm's wrapper and is reported right.
- `<meta http-equiv="refresh">` and the `Refresh` header are parsed the way
  the browser parses them (whitespace, the time, `;` or `,`, `url` in any
  case with or without `=`, a URL without `url=`, matching quotes dropped)
  instead of a regex that needed a literal `url=`; a bare time or a URL that
  is not http(s) is left alone.
- `XMLHttpRequest` in pages and workers behaves like the browser's where it
  did not: `responseType` `json` gives the parsed value (null when it does
  not parse), `blob` a Blob with the response's type, `document` a Document
  (HTML or XML by content type) and `responseXML` with it, which also comes
  for an XML response under the default type and throws InvalidStateError
  under the other types; the event sequence is `loadstart`, `progress`,
  `load`, `loadend`; `timeout` is implemented (timeout then loadend, status
  0); `abort()` and a failed request end with `loadend`; `upload` exists and
  reports the body sent; `withCredentials` is kept and reaches the jar as
  the credentials mode. Measured against the browser on one page before the
  fix: of eleven shapes none matched; after: all eleven.
- A message posted to another proxied window names its real sender. Every
  `x.postMessage(...)` call (and the `.call`, `.apply` and `Reflect.apply`
  forms) is rewritten to go through the caller's access API, which calls the
  receiver's native `postMessage` from the caller's realm, so the browser
  takes the caller as the incumbent: `event.source` is the sender's window
  and the envelope carries the sender's real origin. Before, a same-origin
  child posting to its parent went through the parent's own wrapper and the
  parent was reported as its own source. Ports, workers, plain objects, a
  restricted window and a `postMessage` the page replaced are called as
  written. Cost: a 10.8 MB YouTube bundle rewrites to 19,269,309 bytes
  instead of 19,268,215 (25 call sites), in the same time.
- Four small corrections of rewritten code: `eval(x)` returns anything that
  is not a string unchanged (it was stringified); the generator and async
  generator function constructors run rewritten code and read back like
  `Function` does; a base64 `data:` body is decoded and encoded as UTF-8 (a
  stylesheet or script with characters beyond Latin-1 was mangled); a
  top-level `var location = url` or `var { location } = o` in a classic
  script, which assigns the window's location, is bound to a temporary and
  routed like `location = url` (it navigated to the proxy origin's path).
- A stylesheet the CSS parser cannot fully shape still reaches the page with
  its url()s routed: a block under a malformed at-rule prelude (raw text to
  the parser) is routed by the url() regex inside the parse, and a stylesheet
  the parser rejects outright is routed by the regex alone instead of being
  refused. Measured: css-tree accepted every malformed input tried, but left
  such blocks unrouted.
- A fetch or XMLHttpRequest the page aborts is dropped by the worker too.
  The browser does not relay an abort to a service worker (the request's
  signal in the fetch event never fires in Chrome, measured), so the page
  puts an id on the request and posts the abort to the worker under it; the
  worker stops waiting for the origin, reports the request at once with
  status 0 and `error: "aborted"`, and cancels the origin's answer unread
  when it arrives, so the transport stops reading. Before, the worker waited
  for the origin and reported the request as completed.
- The value of a computed member assignment is rewritten. `o[k] = v` becomes
  a `set2` call and `v` was passed to it as written, so `cache[key] = top`
  stored the real top window, `data[name] = location.href` the routed URL, and
  a function literal assigned that way kept every `top`, `location` and
  `postMessage` inside it raw. The value now goes through the rewriter like
  any other expression (rewriter-unit shape).
- A frame nested in a proxied page sees the proxied world and nothing above
  it, measured against the same pages framed natively (parent-read suite,
  both modes). `parent` was right in every form already; around it:
  `location.ancestorOrigins` lists the proxied ancestors' real origins
  (nearest first) instead of nothing; `frames[i]` and `window[i]` landing on
  a frame of another proxied origin give its restricted window, not the raw
  one (every proxied site shares the real origin); the restricted window
  reports `length` (it reported `closed`), serves its frames by index, and
  throws a `SecurityError` DOMException of the page's realm (the name was
  `Error`); and `otherWindow.top` resolves to the top of that window's world
  instead of the window itself.
- Standalone SVG documents and XHTML pages are proxied as what they are. An
  XML document got the HTML shell under its XML mime (the browser parsed the
  shell as XML and showed nothing) or, for XHTML, nothing at all (raw, with
  `top` and every URL leaking). Both now get an XML shell (the same root
  element and namespaces, XHTML script elements, CDATA) under their own mime;
  the client parses the markup with that mime, rewrites the scripts and
  re-creates the tree through the hooks, namespaces kept, under the shell's
  root (an XML document has no `document.write`; a replaced root would lose
  the SVG title). The clone helper creates every element in its own namespace
  now, so an inline SVG inserted from a markup string is an SVG element, and
  the hooks that compared uppercase HTML names (attribute routing, script and
  style insertion, the script source readback) know an XHTML document's
  lowercase ones and leave an SVG `<script>` to its own hook. A string inside
  `image-set()` or `src()` is routed like a `url()` and reads back as
  written.
- An HTML blob built from bytes (an ArrayBuffer or a typed array, as a
  `text/html` Blob or File) is decoded with the type's charset (UTF-8 by
  default) and wrapped like one built from strings; bytes that do not decode,
  and blobs built from other blobs, are left as they are.
- Relocatable asset names: `assets` on both controllers names the served
  files (`serviceWorker`, `injectDocument`, `injectWorker`, `controllerFrame`,
  `controllerFrameScript`), each defaulting to the file's own name. The
  worker's shell and the worker bootstrap build the inject URLs from them, the
  controller frame registers the worker by its name, `RemoteController` loads
  the frame by its name and tells it its script with `?script=<name>`, which
  the frame's inline loader accepts as a bare file name only (anything else
  falls back to the default). A host can therefore serve the bundle from any
  directory with every file renamed so that no requested URL carries the
  package name (assets suite: a renamed bundle boots, proxies a page and a
  worker, and the fixture saw no URL with "stomp" in it). Not URLs, so
  unchanged: the `$stomp$` postMessage keys and the `stomp` RPC id (same-origin
  messages), the `stomp-allowed-origins` meta in the controller frame, the
  `stompCookies` and `stomp-http-cache` storage names, and the default
  directory `/stomp/`.
- Request rules: `rules` on both controllers and `setRules(rules)` to replace
  them, run in the service worker on the real URL after it has rebuilt
  Referer, Origin and cookies and before the cache. A rule matches by URL
  (a URLPattern string, so `http://*:*/ads/*` includes any port), method,
  destination and site, and the first match wins: `block` answers 403 with
  an empty body, `status` answers without going upstream, `redirect` answers
  307 to a real URL (routed, nested kind kept), `requestHeaders` and
  `responseHeaders` set or delete (`null`) headers. A rule whose pattern
  cannot be compiled (URLPattern is Chrome-only today) is skipped with one
  console warning naming it. Blocked, answered and redirected requests show
  in `onRequest` with their status and the reason as `error`; every report
  of a request a rule touched carries `rule`, the rule's index. Bodies and
  functions are out of scope by design.
- A nested cross-site frame is judged by the top-level page, as a browser
  does. The page routes a child document's URL (an iframe's src, and every
  navigation from inside a nested frame: links, forms, location, history,
  meta refresh, window.open) with a route kind that names the top-level
  proxied origin, and the service worker widens the request's site by it,
  for the navigation itself and for every request whose referrer is such a
  document: a nested cross-site frame gets `SameSite=None` cookies only,
  while a top-level cross-site navigation of the page still carries Lax
  (Sec-Fetch-Site does not walk the ancestors, see the fetch metadata fix). The kind is decided in the page realm, so a page
  holding the codec key could route a child as top-level; that is the same
  trust boundary as every rewriting decision.
- The HTTP cache serves stale entries exactly as far as the origin allowed:
  within `stale-while-revalidate` a stale entry answers at once and one
  revalidation per URL runs behind the page (however many stale hits arrive
  together); within `stale-if-error` a stale entry answers for a 5xx or a
  request the transport could not complete. Past either window, and under
  `must-revalidate`, nothing changes. A cache-served response carries an
  `Age` header (the standard marker; `Warning` is deprecated) and the request
  log says `cached: true`.
- A document the page builds itself and shows from a `blob:` URL (a
  `text/html` Blob or File in a frame or a window) is injected and rewritten
  like a fetched one: its string contents are wrapped in the shell at
  construction, with the page as its URL (`location`, relative URLs, the
  spoof all answer for the page). Blobs of any other type, untyped blobs and
  HTML blobs built from binary parts are untouched.
- The Referer follows the page's own referrer policy. The browser derives
  every request's policy natively (the document's `Referrer-Policy` header,
  which now reaches the browser; `<meta name="referrer">`; an element's
  `referrerpolicy`; fetch's `referrerPolicy` init), and the service worker
  applies all eight policies to the real origins. In proxy URL space every
  proxied request looks same-origin to the browser, so its own Referer is
  used only to learn the initiator; when a policy made it send the proxy
  origin alone, the initiator is the request's client document. An empty
  policy is `strict-origin-when-cross-origin`, as before.
- `document.cookie` no longer costs a synchronous round trip per read: the
  page caches the string and drops it when the jar may have changed, on its
  own write, on a write by another document of the site (a version the
  writer bumps in the proxy origin's own storage, seen synchronously), when
  a response reaches the page (fetch, XHR), and on the service worker's
  broadcast for a Set-Cookie it applied, sent before it answers the response
  that carried it, so the next read is fresh. Fifty reads cost one round
  trip.
- A child frame whose parent touched it before it loaded (its initial
  about:blank window is reused for the real document) threw "Illegal
  invocation" on every `document.cookie` access: the parent's client had
  hooked it and checked against the parent's document.
- Leak fix: the sync route behind `document.cookie` (`/cookies/get`) handed
  page script the whole jar, HttpOnly cookies included, and relied on the
  page's own module to filter them out. The route now answers without them.
- WebSocket handshakes carry the jar's cookies, HttpOnly ones included, under
  the SameSite rules for the page's origin (its Origin header; `ws` counts as
  `http` for the site). The controller adds the Cookie header to the
  handshake in its own realm (the page's module no longer sends one, and one
  the page sends is dropped), so the value never enters the page; without an
  answer from the worker the handshake goes out without cookies. A
  WebSocket URL may be relative or `http(s)`, as in a browser. The Cookie
  Store API is removed from pages, so feature detection falls back to
  `document.cookie`, which the jar serves.
- Styles and references read back as the page wrote them: computed styles
  (`getComputedStyle`, property and `getPropertyValue`), an inline style's
  `getPropertyValue`, and the Typed OM's values stringify with the page's
  `url()`; what the page parses (`CSSStyleValue.parse`) or sets on a
  `StylePropertyMap` is routed; an SVG reference's `href.baseVal` and
  `animVal` are the written value and setting `baseVal` routes;
  `document.domain` accepts the page's host or a parent domain and refuses
  anything else with a `SecurityError`, as a browser does, instead of the
  proxy origin's refusal.
- A script that arrives in a markup string (`innerHTML`,
  `insertAdjacentHTML`, `outerHTML`) no longer runs: the browser's fragment
  parser marks such scripts "already started" and Stomp's re-creation of the
  parsed nodes had lost that, so the script ran, and raw. The parsed script
  element is adopted instead of re-created.
- Markup is read the way the browser reads it: a script runs rewritten
  whatever the case, spacing or legacy spelling of its JavaScript MIME type
  (and the `language` attribute), with `module` matched as Chrome does; a
  link's `rel` is a token list and a preload's `as` decides its route
  (`stylesheet` or `as=style` to the CSS route, `modulepreload` and
  `as=script` to the script route, the rest binary); SVG gradients,
  patterns, filters, animations, cursors and `tref` route their `href` or
  `xlink:href`, an SVG `<script>` as a script, and an SVG `<a>` made with
  `createElementNS` like an HTML link.
- The Cookie header follows SameSite: the service worker asks the jar with
  the request's site (from the fetch metadata it computes), whether it is a
  navigation and its method, so a cross-site subresource carries
  `SameSite=None` cookies only and a cross-site GET navigation adds Lax but
  never Strict. Every proxied page reaches the worker as an iframe
  destination, so iframe navigations count as top-level: a cross-site link
  into a site that keeps its login in Lax cookies works, and a nested
  cross-site iframe gets Lax cookies a browser would withhold.
  `controller.cookies.list()` records carry `hostOnly`. (Nested frames are
  judged by the top-level page since the nested route kind.)
- The HTTP cache serves a request that arrives while the same URL's entry is
  still being written (its body streaming into the store) from that entry,
  instead of racing it upstream; on a slow machine the second of two fetches
  in a row could miss. A controller handed a worker other than the
  registration's active one now moves to the active one at once, before
  waiting on an update.
- Documents that escaped the rewrite: a child frame's `sandbox`, `csp` and
  `credentialless` attributes are dropped (an opaque origin or a policy would
  put its document outside the service worker; the page reads them back as
  written), an import map's targets are routed as modules (package prefixes
  and scope keys are left as written: they are URL prefixes a routed URL
  cannot keep), and an about:blank popup the page opens without a URL is
  injected like a child frame, so what the page writes into it is rewritten.
  `window.open` hands only http(s) URLs to the host's `onOpen`.
- A proxied page reads its own URLs back: `PerformanceEntry.name` and
  `toJSON` un-route (`getEntries*`, `PerformanceObserver` lists and
  `takeRecords` hide the inject bundles' entries; `getEntriesByName` takes
  the page's URL), `hashchange` `oldURL` / `newURL` and the Navigation API's
  entry and `destination` URLs are the page's, error stacks name the page's
  scripts (V8 `Error.prepareStackTrace`; a page's own formatter runs on
  cleaned frames, inject frames dropped), a script the page inserted reads
  back the source it wrote, and `document.documentURI` / `window.origin`
  agree with `document.URL` / `location`. Parser-inserted scripts no longer
  read `&amp;` for `&` in `currentScript.textContent`.
- `RemoteController` is an `EventTarget` like `StompController` and mirrors
  the controller frame's `stale` property and its `stale` / `rebind` events
  (one RPC from the frame), so an isolated host shows the same notice.
- A URL attribute changed after it was routed takes effect. Once the hooks had
  routed an element's `href` or `src`, every later `setAttribute` or property
  assignment was discarded in favour of the stored original, so links and
  images never updated after their first routing; the hooks now tell their
  own value from one the page changed.
- Links and the URL attributes around them: `<area href>` is routed like
  `<a href>`; `formaction`, `input[src]`, `video[poster]`, `track[src]`,
  `object[data]`, `frame[src]` and `link[imagesrcset]` are routed and read
  back as written; the URL parts of a link (`a.pathname`, `a.host`,
  `String(a)`, also on `<area>`) are the link's own instead of the page's,
  and setting one updates the link, routed.
- The cookie jar follows RFC 6265bis: cookies set without `Domain` are
  host-only, `Domain` matches by label and never a public suffix, paths match
  on a boundary from the request's default path, `Secure` cookies go to secure
  URLs only and an insecure origin cannot replace them, `__Host-` /
  `__Secure-` prefixes, the 4096-byte cap and control characters are enforced,
  `SameSite=None` needs `Secure`, `Max-Age` beats `Expires` with a 400-day
  cap, the Cookie header lists longer paths first then earlier creations, and
  a page's script can neither set nor replace an HttpOnly cookie. Session
  cookies survive a service worker restart (they were wiped every time the
  idle worker was restarted, which logged users out).
- A build mismatch at the handshake never blocks the page. After a deploy the
  page loads the new controller bundle while the old service worker is still
  the active one, so the controller updates the registration and, when the
  new worker activates within five seconds, binds to it
  (`controller.rebind(worker?)`, public) and shakes hands again. When it does
  not (the old worker is pinned by a request that never settles), `wait()`
  resolves on the old worker, `controller.stale` records both builds with a
  `stale` event for the host's notice, and the new worker is adopted the
  moment it activates (`updatefound`, `controllerchange`; a `rebind` event
  follows). `wait()` no longer rejects over a version mismatch.
- The service worker bounds every routed request: a response that has not
  started after 60 seconds (120 for documents and media) is answered 504
  with a short error page or an empty body, so a transport request that
  never settles cannot keep the worker alive and block a waiting worker of a
  newer build from activating.
- `allowInvalidJs` on both controllers (default `true`, today's behaviour): a
  script the rewriter cannot parse runs as it was. With `false` it fails with
  a `SyntaxError` naming the rewriter error instead, so a broken rewrite is
  loud while developing (scramjet's dev preset does the same).
- `debugger` statements are removed from proxied scripts: on a proxied site
  they are an anti-debugging trap, not the user's breakpoint.
- `npm test` includes a node-side suite (`rewriter-unit`) that bundles the
  JS rewriter with esbuild and asserts the generated code itself; it skips
  with a message where esbuild is not installed.
- A dynamic `import()` in a classic external script resolves against the
  script's URL instead of the document's, and modules get
  `import.meta.resolve()` (the page's URLs; a bare specifier comes back as it
  is).
- Destructuring reaches the spoof at every depth: `const { a: { top } } = o`
  and `({ a: { location: l } } = o)` resolve through the wrapped source like
  the shallow form did, and a destructured parameter
  (`function f({ top: t }) {}`, arrows, methods, with or without a default)
  becomes a plain parameter whose pattern is declared at the top of the body
  and wrapped the same way. Array patterns (`const [{ top }] = [w]`) and a
  nested default (`{ a: { top } = w }`) still read the real value.
- A page's own `history` is scoped to its frame: `length` counts the frame's
  entries instead of the joint session history of the host page and every
  frame in it, and `back()`, `forward()` and `go()` step those entries only
  (Navigation API); a step past either end does nothing, as on a top-level
  page, instead of handing the traversal to the host or a sibling frame.
- A page that calls `document.open()` keeps the window hooks: the message
  filter and tagger, the link and navigate listeners are registered again,
  as they already were after the open that writes the page. The tagger that
  unwraps messages from other Stomp windows is also registered at install.
- Request bodies reach the transport as a Blob (see the Content-Length
  entry above for why they no longer stream).
- The controller, the service worker and the inject bundles carry a build
  id; a mismatch (a stale bundle next to a new service worker) rejects
  `controller.wait()` with both ids and logs one error in the page, instead
  of failing somewhere else later.
- Response headers that would bind a page to the proxy origin (HSTS,
  `Clear-Site-Data`, COEP, reporting, `Permissions-Policy`, nosniff) and the
  already consumed `Set-Cookie` are stripped; `Link` preloads and
  `Content-Location` are rewritten; requests carry `Origin`, a
  default-policy referrer and fetch metadata computed for the real origins;
  EventSource responses get their MIME type.
- `BroadcastChannel` names, Cache API caches and the origin private file
  system are partitioned by proxied origin.
- `storage` events fire in the other documents of a proxied origin when
  localStorage changes (never in the writer, never across origins).
- Workers started from `blob:` URLs, module workers, `SharedWorker` and
  `Worklet.addModule` work through the proxy; module workers lost their
  inject to a missing `importScripts`, and blob workers could not be read by
  the service worker.
- Frameworks that read the DOM back see what the page wrote:
  `getAttributeNames`, `hasAttribute`, `Element.attributes` and `Attr.value`
  hide the proxy's marker attributes, `innerHTML` / `outerHTML` serialise the
  page's own URLs, and attribute selectors (`a[href^="/"]`) match the page's
  values. `setAttributeNS`, `toggleAttribute`, `setAttributeNode`, SVG
  `href` / `xlink:href` and nodes from `DOMParser` or
  `createContextualFragment` are routed like everything else.
- Rules added with `insertRule`, constructable stylesheets (`replace` /
  `replaceSync`, `adoptedStyleSheets`) and `FontFace` sources are rewritten;
  CSS-in-JS and font loaders fetched from the proxy origin. The text of a
  `<style>` element is rewritten before the browser parses it, so its
  `@import` and fonts are never requested unrouted first.
- Destructuring an unforgeable (`const { top: t } = window`,
  `({ top: t } = window)`) resolves to the spoofed value; `document.location
= url` is routed like `window.location`; `opener` is null unless another
  proxied page opened the window, and `opener.top` can no longer reach the
  host.
- Inline event handler attributes, `javascript:` URLs and string arguments
  to `setTimeout` / `setInterval` are rewritten (they ran unrewritten and
  could reach the real `top`); `<iframe srcdoc>` documents are injected and
  rewritten like fetched ones; `target=_top` / `_parent` (and `formtarget`
  and `window.open` targets) navigate the proxied frame itself, as a
  top-level page would, instead of being refused by the sandbox.
- Inline module scripts carried their original text next to the rewritten
  one (the `text` setter hook removed children while iterating the live
  list) and lost their `currentScript` preamble to a null, so any module
  with an import binding failed to parse.
- Bare import specifiers (`import x from "react"`) are left to the page's
  import map instead of throwing in `new URL`; `export ... from` sources are
  rewritten; the rewriter's identifier skip list covers class fields, catch
  parameters, class expression names, labels, `typeof`, import bindings,
  for-in/of targets and alias destructuring; `{location}` shorthand prints
  the rewrite. A script the rewriter cannot parse now runs as written with a
  console warning instead of becoming `throw new SyntaxError` (see known
  limitations).
- Cookie `Max-Age` is seconds, not milliseconds, and `Max-Age=0` deletes; a
  re-set that flips a cookie between session and persistent replaces it.
- `<template>` contents survive loading (`cloneRawNode` read `childNodes`,
  which is empty for templates).
- Documents are decoded with their declared charset (BOM, `Content-Type`,
  `<meta charset>` prescan) before rewriting and served as UTF-8; Shift_JIS,
  windows-1252 and UTF-16 pages were mojibake.
- `location.reload` exists on the location proxy; `IDBDatabase.name` reports
  the page's name rather than the tail of `name@origin`.
- `npm test` runs every suite at once by default (`PARALLEL` defaults to the
  core count) and splits the Back walk and escape suites into independent
  parts; a fixture-based Back walk (`backwalk-fixture`) covers the same steps
  as the Wikipedia walk without network.
- epoxy comes from `deploy/epoxy/`: pinned upstream revisions plus patches
  (hyper-util-wasm exposes the HTTP/2 header-list limit, epoxy-tls sets it to
  256 KiB like Chrome instead of hyper's 16 KiB default, which reset YouTube
  and other header-heavy sites with `PROTOCOL_ERROR`), built in a container
  and published to the `dist` branches of `Fracital/epoxy-tls` and
  `Fracital/EpoxyTransport`, from which `package.json` installs it. No Rust
  toolchain is needed to install.
- Two epoxy hangs, fixed by two more patches in `deploy/epoxy/` (once
  published and pinned). Requests that started in one tick on a cold
  transport lost all but one: each called `init()`, epoxy instantiated its
  wasm module once per call, and the client built on the replaced instance
  never answered ("memory access out of bounds" in the console); epoxy now
  loads once however many requests wait for it. And a request to an origin
  that had closed an idle keep-alive connection (node closes after 5 s) hung:
  wisp's stream close never left its queue, so hyper's pool kept the dead
  connection and handed it out; the close now goes out and the pool drops the
  connection. Measured by the new `epoxy-concurrency` suite (2, 4 and 8
  same-origin navigations, fetches and raw transport requests at once, and
  again after the idle timeout; libcurl on a real site as the control).
- The synchronous bridge throws a `QuotaExceededError` at once when the
  browser refuses its beacon (payloads over 64 KiB, such as a large
  `localStorage.setItem`), instead of spinning until the wall-clock limit
  and freezing the page for seconds per call (Wikipedia's module cache
  triggered this on every navigation).
- The demo's Back button could walk the browser out of the demo page, or
  bounce between the home screen and the last page: the per-tab history list
  over-counted redirected and replaced URLs, so `history.back()` ran at the
  frame's first entry, and Back on the home screen re-entered the tab. The
  frame is now the authority on whether it can step, presses queue up one
  step at a time, and Back on the home screen does nothing.
- Nested frames were given the codec _name_ instead of the codec key when
  their client was created. They now reuse the parent's key.
- In origin-isolation mode the `frame-ancestors` policy only named the host,
  so a proxied page's own iframes (also on the proxy origin) were blocked.
  The policy now includes `'self'`.
- Setting `textContent` on a Text or Comment node threw
  `append is not a function` (the hook assumed an element); the native setter
  now handles nodes without children. Seen on YouTube.
- `data:` script URLs were rewritten without percent-decoding the body, so
  Reddit's `data:text/javascript,%7B...` scripts became `SyntaxError: Unexpected
token '%'`. The body is decoded before rewriting and re-encoded after.
- The synchronous cookie/storage bridge never worked in origin-isolation
  mode: the service worker answers through `cookieStore.set`, whose default
  `SameSite=Strict` is invisible to `document.cookie` in a proxied frame (a
  cross-site embed of the proxy origin), so every `document.cookie` and
  `localStorage` call spun until its limit and threw. The answer cookies are
  now `SameSite=None`. The spin limit was also a fixed cycle count (about a
  second) and is now wall-clock, 10 s for loopback routes, so a service worker
  busy rewriting a large script (YouTube's main bundle takes over two seconds)
  no longer makes `document.cookie` throw.
- Inline styles: the `style` attribute hook re-wrote the browser's own
  serialization of the text it had just written (Polymer assigns the changed
  attribute back to `el.style` from `attributeChangedCallback`), flipping the
  attribute between the original and the rewritten text until the stack
  overflowed; YouTube froze a few seconds after rendering. The hook now
  recognises the echo. The generic property setter also re-assigned
  `el.style = el.style` after a write, which `PutForwards=cssText` turns into
  `"[object CSSStyleDeclaration]"` and wipes the inline style; the re-assign
  is skipped when the getter does not return a string.
- Inline scripts that a page inserts at runtime (`script.textContent = ...`
  then `append`, `innerHTML` / `insertAdjacentHTML` with a `<script>`, a
  text node appended to a script) ran unrewritten: the insertion hook skipped
  scripts that were not connected yet, which at insertion time is every one
  of them. They saw the proxy URL in `location` and reached the real `top`.
  Scripts are now rewritten when the tree they land in is connected, once per
  element.
- `top.location = x` (and `top[k] = x`, `top.location ||= x`) handed the
  rewriter's `set2` the real `top` instead of the spoofed one, so in
  same-origin mode it navigated the host page to the unproxied URL. The
  assignment target is now rewritten like reads and calls are.
- Same-origin `Frame`s had no `sandbox`, so `<a target="_top">`,
  `<a target="_parent">`, `<form target="_top">` and
  `window.open(url, '_top')` on a proxied page replaced the host page with
  the proxied one (reproduced on the demo). `StompController` now applies
  `DEFAULT_SANDBOX` to every frame it creates; `sandbox: null` in
  `ControllerInit` opts out. This is hardening, not a security boundary:
  same-origin frames can still reach the host DOM, and Chrome warns that a
  sandbox with both `allow-scripts` and `allow-same-origin` can be escaped.
- The demo's tab switcher expanded a card to the full stage (top of the
  viewport, above the navigation bar) while the frame rests below the
  address bar, so the page jumped down by the bar's height and the iframe was
  resized when the stage went away. A card is now a scaled preview of the
  whole browser view, address bar included (the tab's URL and title in the
  bar's own styles), and expanding it is one transform of that block: the
  bar copy lands on the real bar and the frame on its resting box. The
  browser view also leaves room for the navigation bar instead of hiding the
  bottom of every page under it, and the dock buttons fade out when a tab is
  opened from a switcher that was entered from the home screen (they used to
  stay put and vanish).
- The demo prints its deployment facts (mode and origins, transport and wisp
  endpoint, version, controller state, boot errors) as styled console badges
  instead of showing the isolation mode on the landing page.

### Origin isolation

- `RemoteController` / `RemoteFrame`: the host page embeds
  `dist/controllerFrame.html` from a separate proxy origin; that frame
  registers the service worker, loads the transport and runs the real
  controller, driven over `postMessage` with origin checks.
- Proxied content lives in sandboxed, cross-origin frames (no
  `allow-top-navigation`), and the service worker emits
  `Content-Security-Policy: frame-ancestors <host>` on proxied documents.
- Framing spoof (`src/inject/dom/modules/Framing.ts`): `frameElement` is
  null, `window.name` is a shadow value, outer size and screen position
  match the inner size, `document.referrer` never reveals the host,
  `location.ancestorOrigins` is empty, and `message` events from outside
  the proxied world are dropped. `top` and `parent` resolve to the page
  itself across a cross-origin parent.
- Transports are described (`{ module, options }`) rather than passed as
  instances in isolation mode. The demo runs isolated on
  `localhost` (host) vs `127.0.0.1` (proxy).

### QA pass (headless Chrome against the demo)

Fixed while testing real sites and a feature fixture:

- `window.top` inside a proxied frame now resolves to the outermost proxied
  context instead of the host page (`top` is unforgeable, so this goes through
  the JS access rewrite).
- `document.cookie` no longer exposes `HttpOnly` cookies.
- `history.pushState` with a fragment no longer doubles the hash.
- `@import "file.css"` (string form) is rewritten; only `url()` was before.
- `Referer` and `Origin` are rebuilt from the proxied referrer; the service
  worker never sees the browser's own copies.
- Forms submitted to an `action` set after `method` no longer post to the
  page itself.
- `EventSource` could not be constructed.
- Inline scripts whose rewritten code contained `</script` ended the element
  early; inline `type="module"` scripts were rewritten with the script goal.
- Optional chaining through a computed member (`a?.[k]`, `a?.[k]()`) kept its
  short-circuit semantics only in the generated text, not at runtime.
- Custom element reactions ran while the element still had Stomp's hook
  prototype (`this._$AK is not a function` on Lit sites).
- URLs inside inline styles were never rewritten: `style="..."` on any element,
  `element.style.x = ...`, `style.setProperty`, `style.cssText`, CSS custom
  properties (`--x: url(...)`) and `insertAdjacentHTML` all leaked the real
  origin. Reads give the page back its own value.
- `<script src>` is re-routed when `type="module"` is set after `src`.

### Known limitations

- The same-origin policy between proxied sites is simulated by the proxy
  (docs/same-origin-policy.md). Not yet: `crossOriginIsolated` (COOP and
  COEP cannot isolate a proxied frame).
- A visit that makes no history entry in a frame is not recorded for
  `:visited` (docs/same-origin-policy.md, "What is not recorded"):
  `location.replace`, `replaceState`, a meta refresh, a tab the host
  opens, and the navigations of a page that listens to the Navigation API
  events. Their links read unvisited.
- The Cookie Store API's change events are dispatched by the inject, so
  their `isTrusted` is false where natively it is true (native-shapes
  suite, recorded), as for the storage events of other documents' writes.
  A change made before the page first reads `cookieStore` is not reported,
  and neither is one between that read and the jar's first answer when the
  page made no Cookie Store API call in between.
- In isolated mode the whole proxied page is cross-origin to the host, so
  Chrome itself holds the animation frame callbacks of every hidden frame in
  it, including one of the page's own origin, which natively keeps running
  them (hidden-frames suite, which compares only the frames of another
  origin there). Chrome also holds a cross-origin frame that is scrolled out
  of view; the inject holds only frames that are not rendered (or clipped
  away entirely by an ancestor), and it leaves `IntersectionObserver` and
  `ResizeObserver` delivery alone.
- HTTP authentication is Basic only: a Digest, NTLM or Negotiate challenge
  reaches the page as its 401, and a challenge the page has no credentials
  for never prompts (natively the browser asks the user). The credentials
  the worker keeps for a realm last as long as the service worker does.
- A proxied YouTube video can stop at about 45 seconds ("Something went
  wrong"), and how often follows the network path of the session's requests
  to youtube.com, not the page. YouTube's SABR stream answers every request
  with `STREAM_PROTECTION_STATUS` 2 (attestation pending) until the player's
  PoToken is accepted, then 1; on these loads it never accepts it and sends 3
  (attestation required) at about 30 seconds with no media, so playback ends
  when the buffer does. Measured 2026-11-10 with headful Chrome 152,
  alternated loads, refused loads of those with a verdict
  (docs/http3.md, "YouTube's attestation"). From a machine whose traffic
  leaves through a WireGuard tunnel, over HTTP/2: 14 of 20 through wisp-js,
  12 of 19 and 13 of 20 through holyWisp on the same machine, so the wisp
  server makes no difference. Chrome itself from that machine, no proxy: 0
  of 56, and 13 of 36 with `--disable-quic`, which leaves it the TCP
  connections the proxy has. With `http3` on, which sends the proxied
  requests over QUIC as Chrome sends its own: 1 of 20 and 1 of 16. Through
  the holyWisp edges the same build was refused 4 of 36 times over HTTP/2
  and 3 of 20 with `http3` on. So where videos stop, turn `http3` on (the
  wisp server has to relay UDP) or give the wisp server another way out.
  What YouTube holds against TCP connections from that machine's address
  is not known: the tunnel shows in every SYN (an MSS of 1320), and the
  refusals over TCP rose through the day's measurements (about one load in
  four in the morning, two in three by evening, and from 0 of 21 to 3 of
  20 through the edges), while those over QUIC did not. Run unrewritten
  under the proxy, the attestation script is refused every time. A reload
  is a new draw.
- Markup a page sets as an SVG or MathML element's `innerHTML` or
  `insertAdjacentHTML` is parsed as if its context were an HTML element, so
  `svg.innerHTML = '<style>...</style>'` makes an HTML `<style>` where
  natively it is an SVG one (svg-style suite, left out of its kind check;
  its CSS loads through the proxy either way). Markup holding the `<svg>`
  element itself is parsed as natively.
- A proxied page can still reach another proxied site's window raw in these
  ways (window-references suite, which asserts them raw so a fix shows up):
  a window it reached while the window was of its own origin (a frame read
  before it went to another site, a popup from `window.open()` it then
  navigated) stays the browser's WindowProxy, which the inject cannot take
  back, and through it the other site's document once it arrives (natively
  the browser starts throwing then); copies of a window's children the
  browser makes itself (`Array.prototype.slice.call(frames)`, `forEach`,
  `{ ...window }`); and the document's named iframe (`document.kid`), whose
  named properties come before anything that could be defined. Closing these
  needs a membrane over every window the page holds, or a real origin per
  proxied site.
- A page's iframe sandbox (sandbox-restrictions suite) is enforced by the
  browser for everything but scripts, the opaque origin and top
  navigation, which the inject emulates, with these limits. A frame
  sandboxed with allow-scripts but without allow-same-origin runs in the
  site's real origin through the proxy: what the inject routes is
  restricted, but a raw path (a literal frame index such as
  `parent.frames[0]`, never routed) reaches another window's document, and
  only its fetch and XMLHttpRequest go as an opaque origin's (its element
  loads, sendBeacon, EventSource and WebSocket handshakes carry the site's
  origin and cookies). A popup it opens with `noopener` in the features
  string loses the inherited sandbox. In a frame without allow-scripts the
  script policy also refuses what natively runs there on behalf of a
  same-origin parent (`frame.contentWindow.eval(...)` throws EvalError) and
  the host's `init.hooks` (compiled in the frame's realm); autofocus and
  autoplay are not blocked there (the real frame allows scripts, which
  turns them on); an XML document there has its scripts stripped rather
  than refused by a policy. A form with `target="_top"` under
  allow-top-navigation is refused by the browser where natively it
  navigates the top. The sandbox is read when the document starts, not
  when its navigation does, so a page that changes the attribute while the
  navigation is in flight gets the new value. An `<object>`'s HTML document
  is a blob: copy whose relative loads miss the worker, sandboxed or not.
- A page that races its own parser against an async script loses that race
  more often through the proxy, because its parser-blocking scripts arrive
  later: each is rewritten in the service worker, and Chrome fetches every
  script its preload scanner found in a `document.write`d document a second
  time when a service worker controls it (measured with a pass-through
  worker and no Stomp). The TinyMCE docs page sets `piAId = ''` at the end of
  its body while Google Tag Manager's page-view tag sets the Pardot IDs as
  soon as gtm.js arrives; natively the parser wins by about 40 ms, so a
  throttled native load (150 ms latency) clobbers the IDs too, and Pardot
  answers `campaign_id=null` with an HTML refusal its script tag cannot
  parse. Nothing in the rewrite is involved: sloppy global writes, script
  order and GTM's inserted scripts behave as natively.
- Scripts created from markup strings read back rewritten.
- A page that names the access API reads it: `window.$s$j`, `window[name]`
  and `typeof $s$j` give an object where natively there is nothing (tells
  suite, recorded). The client's name reads undefined, and nothing lists
  or finds either name.
- Error surfaces (error-surfaces suite): line and column numbers of rewritten
  code are the rewritten code's (stacks, ErrorEvent, onerror, report bodies),
  and an error the browser reported for a worker the page terminated mid
  import names the worker's script at line 0 (the worker can no longer say
  where). With a formatter installed V8 builds a stack's first line when the
  stack is first read, not when the error is made, so a page that changes an
  error's message before reading its stack sees the new message there
  (Blink's own prefix is handled). A page's CSP is not forwarded, so no
  `securitypolicyviolation` fires; a classic script of another origin that a
  worker imports does not mute its errors; DevTools' structured call frames
  (not readable by the page) still show routes.
- Aborting a fetch does not cancel the request on the transport (epoxy
  ignores the signal); the response is discarded.
- The HTTP cache differs from Chrome's in one listed way
  (docs/http-cache.md): other credentials than an entry's revalidate it.
- `getSVGDocument()` is not spoofed.
- WebAuthn with the real site's `rpId` (a passkey sign-in) is not a
  suffix of the proxy origin, so Chrome tries a related-origin fetch of
  `https://<rpId>/.well-known/webauthn` itself, past the service worker
  (measured on Chrome 152: its SecurityError says the fetch was made;
  neither Playwright nor CDP shows the request), and the ceremony fails.
  That request reaches the real site directly; it is not handled yet.
- `CSSRule.cssText` assignment is not rewritten (a no-op for style rules).
  Un-rewritten `url()` values read back as the page wrote them (relative
  when written relative), not as the absolute URL a browser would serialise.
- Array destructuring patterns (`const [{ top }] = [w]`) and a nested
  pattern's default value (`{ a: { top } = w }`) still read the real value.
- In same-origin mode a `postMessage` from the host into a frame runs the
  frame's own hooked `postMessage`, so it arrives as if the page had sent it;
  only the cross-origin boundary of isolation mode lets the filter drop it.
- A script the rewriter cannot parse runs unrewritten (unless
  `allowInvalidJs: false`). In isolation mode the
  sandbox and the cross-origin boundary contain it; in same-origin mode it can
  reach the real `top`, which is one more reason that mode is not a security
  boundary.
- The code of a `blob:` worker runs with the worker hooks but is not itself
  rewritten; worklet modules get no inject; an HTML blob built from another
  Blob is shown as it is.
- Transports, as tested against `wisp-js` 0.5.2 with or without Stomp in the
  path: epoxy 3.0.2 handles HTTP well but stops delivering incoming WebSocket
  frames after the first round trip; libcurl 2.0.6 handles WebSockets but
  stops answering HTTP after roughly 70 requests with its default pool and
  roughly 160 with a larger one, which breaks any page that fans out that many
  assets. The demo defaults to epoxy and raises libcurl's pool when selected.
- A wisp server that never refills a TCP stream's credit (wisp-js 0.5.2 and
  older send CONTINUE for UDP streams only) stalls an epoxy stream after
  its first window, 128 packets there: an upload over 8 MiB, or a long-lived
  connection's 128th write. Run wisp-js 0.5.3 or later.
- Wisp has no flow control from the server to the client, and epoxy queues
  each stream's incoming data without a bound, so a response nobody reads
  (a paused media download) keeps arriving into the transport worker's
  memory until it ends: of a 1 GB body left unread, the origin had written
  about 950 MB after two seconds, before and after the body ports, which
  bound only the hop from the transport to the reader.
- A request that starts just as the server closes its idle connection fails
  with an error rather than being retried on a new connection the way Chrome
  retries it (the pinned epoxy no longer hangs there; hyper does not retry).
- A WebSocket handshake through epoxy offers no `permessage-deflate`
  (Chrome does): epoxy's WebSocket library refuses compressed frames, so an
  offer the server took would break the socket. Its field names go out
  title-cased (`Sec-Websocket-Key`), which HTTP reads case-insensitively.
  `Accept-Language` on a handshake is the controller's to add from the
  user's languages and is not added yet. epoxy's HTTP requests still say
  `Accept-Encoding: gzip, br`, the encodings it decodes (Chrome adds
  `deflate` and `zstd`).
- A header line holding a control character other than NUL, CR or LF
  (`\x01`, DEL) is skipped by epoxy; Chrome keeps it and hands the page the
  value with the byte in it. An HTTP/2 response is parsed by h2, which none
  of the HTTP/1 leniency applies to.
- A header value with bytes past 0x7F reaches the page encoded as UTF-8 a
  second time (the bytes `c3 a9` arrive as `c3 83 c2 a9`). Chrome
  does that to every such header a service worker's Response carries
  (measured with no proxy: a worker relaying a network response's headers
  unchanged does it too), so the proxy cannot hand the page the site's
  bytes.
- The published epoxy-transport (hyper's HTTP/2 client) resets any response
  whose header block is larger than 16 KiB with `PROTOCOL_ERROR`, and its
  `header_limit` option does not change that. YouTube answers a
  `HeadlessChrome` user agent with a 7 KB `connection-allowlist-report-only`
  header on top of its 6 KB CSP report, a 20 KB block. This project installs
  the Fracital fork (256 KiB, Chrome parity) instead, so YouTube renders here;
  anything still on the npm package, Fracital included, hits it.
- Import maps are passed through untouched: bare specifiers are left to the
  page's map, but the map's own URLs are not rewritten.
- Synchronous XMLHttpRequest and the synchronous storage/cookie bridge spin
  the page's main thread while waiting on the service worker. With the
  transport hosted in the same renderer, a synchronous request that needs the
  network deadlocks until the spin limit (30 s); loopback requests wait up to
  10 s, which covers the service worker rewriting a 10 MB script. The answer
  travels in `SameSite=None` cookies, so in origin-isolation mode the bridge
  needs third-party cookies allowed for the proxy origin.
- Without `onOpen`, `_blank` and named targets open the proxied page in a
  bare new tab outside the host application (the frame sandbox keeps
  `allow-popups`).
