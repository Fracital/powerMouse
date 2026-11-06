# Scramjet parity: what Stomp is missing, and how isolated it really is

Comparison of `stomp-rewrite` (10k lines of TypeScript) against
`~/src/scramjet` (39k lines including the Rust rewriter and the runway test
suite), done 2026-11-06 by reading both trees in full and probing the demo
with headless Chrome. Status words: **missing**, **partial**, **ok**, or
**ahead** (Stomp does more than scramjet). File references are to this repo
unless prefixed `sj/` (scramjet `packages/`).

Measured results are marked "(measured)". Everything else is from reading the
code. The fixes landed alongside this document are listed in `CHANGELOG.md`.

## 1. Verified bugs found on the way (fixed or still open)

| Bug                                                                                                                                                                                                         | Status                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Same-origin `Frame` had no `sandbox`: `<a target=_top>`, `<a target=_parent>`, `<form target=_top>`, `window.open(url,'_top')` replaced the host page (measured, 4 of 8 probes)                             | fixed: `DEFAULT_SANDBOX` on every `Frame`, `sandbox: null` opts out          |
| `top.location = x` passed the raw `top` to `set2`; in same-origin mode it navigated the host to the unproxied URL (measured)                                                                                | fixed: assignment target rewritten (`rewriteJS.ts`)                          |
| Every inline script inserted at runtime ran unrewritten (`textContent`, `.text`, text node, `innerHTML`, `insertAdjacentHTML`): the insertion hook skipped not-yet-connected scripts (measured, 5 of 5 raw) | fixed: rewrite when the destination tree is connected (`DOMContentHooks.ts`) |
| Demo tab switcher snapped the frame 49px when expanding a card, and the browser view hid the bottom 48px of every page under the navbar (measured)                                                          | fixed (`demo/public/pm/main.js`, `main.css`)                                 |
| Cookie `Max-Age` is added as milliseconds, `Max-Age=0` becomes a session cookie (`src/server/Cookies.ts:45`)                                                                                                | open: multiply by 1000, delete when `<= 0`                                   |
| `<template>` children are dropped: `cloneRawNode` walks `childNodes`, which is empty for templates (`src/inject/dom/cloneNode.ts:86`)                                                                       | open                                                                         |
| String arguments to `setTimeout` / `setInterval` run unrewritten (measured)                                                                                                                                 | open                                                                         |
| `{location}` / `{top}` shorthand properties: the rewrite is produced but escodegen prints the shorthand from the key, so it is silently dropped                                                             | open                                                                         |
| Class fields, `catch (location)`, `(class top {})`, `break top` labels, `typeof top`, `var {g: location}` all turn the whole script into `throw new SyntaxError` (`rewriteJS.ts:176-205` skip list)         | open                                                                         |
| Bare import specifiers (`import x from "react"`) and `export ... from` are not handled; a bare specifier makes the whole module a `throw new SyntaxError`                                                   | open                                                                         |
| `fetch(request)` passes the `Request` as `init`; POST requests throw `duplex option is required` (`src/inject/modules/Fetch.ts:101`)                                                                        | open                                                                         |
| `IDBDatabase.name` getter slices the wrong end of `name@origin` (`src/inject/modules/IndexedDB.ts:27`)                                                                                                      | open                                                                         |
| `location.reload` is missing from the location proxy (own property of the real location, not of `Location.prototype`)                                                                                       | open                                                                         |
| Anchor URL parts (`a.pathname`, `a.hostname`) return the page's values, not the link's (`src/inject/dom/modules/Anchor.ts:60,73`)                                                                           | open (already in CHANGELOG known limitations)                                |
| XHR `responseType` `json` / `blob` / `document` return text or ArrayBuffer; `open()` stores the password into `#username`                                                                                   | open                                                                         |
| `MockWebSocket` rejects relative URLs and does not map `http(s):` to `ws(s):`; HttpOnly cookies are missing from handshakes                                                                                 | open                                                                         |
| Context's `message` tagger is only registered on `document.open()`, so about:blank child frames see the raw `{ $s$N: 'stompMessage' }` envelope in `event.data`                                             | open                                                                         |
| `trimNonStandardHeaders` is a no-op (deletes from a fresh `Headers`, callers ignore the result) (`src/headers.ts:165`)                                                                                      | open                                                                         |
| `Set-Cookie` is consumed but not deleted from proxied responses, so the browser also stores site cookies on the proxy origin                                                                                | open                                                                         |
| `Clear-Site-Data` passes through: one site can wipe `stompCookies`, `stompStorage` and the codec key for every site                                                                                         | open                                                                         |

## 2. Isolation and the "I am the top window" spoof

### 2a. The two designs

Scramjet has no browser-level boundary at all. Host, controller and proxied
page share one real origin; separation is rewriting only. Its own test suite
says so (`sj/runway/src/tests/adversarial/origin-isolation.ts`: "real
separation needs a distinct browser origin per proxied site", with the
cross-site assertions marked as known failures). The spoof is: `top`,
`parent`, `location`, `eval` are rewriter UNSAFE_GLOBALS wrapped by
`$scramjet$wrap`, `.top/.parent` member reads become `Object.prototype`
accessors (`sj/core/src/client/shared/wrap.ts`), `frameElement` returns the
real element only if the parent carries the client, `window.open` maps
`_top`/`_parent` to frame names (so the controller's iframe needs a visible
`name`, which pages can read), `document.referrer` is synthesised from
tracked history, `MessageEvent.origin` comes from an envelope, and host
messages are delivered (`shouldBlockMessageEvent` returns false).

Stomp in isolated mode (`RemoteController`) has a real boundary: separate
proxy origin, `sandbox` without `allow-top-navigation`, CSP
`frame-ancestors <host>`, origin- and source-checked postMessage RPC,
transports loadable only from the proxy origin, frames addressed by index
rather than name. The spoof (`Framing.ts`, `Context.ts`) covers
`frameElement`, shadowed `window.name`, outer size and screen position,
routed-referrer decoding, `ancestorOrigins`, host messages dropped in the
capture phase, `top` via the rewriter's `resolveTop`, `parent` via a
redefined getter, and restricted WindowProxy stand-ins for other proxied
origins that throw the real cross-origin `DOMException`. Scramjet does none
of the last four.

Stomp in same-origin mode (the live site) had no boundary and, until today,
no sandbox either. With `DEFAULT_SANDBOX` applied it is now "hardened":
Chrome refuses top navigation from the frame, but the frame is still
same-origin with the host and can read its DOM. Chrome logs a warning that a
sandbox with both `allow-scripts` and `allow-same-origin` can be escaped;
that is accurate and expected.

### 2b. Escape vectors, after today's fixes

| Vector                                                                                                 | Same-origin mode                             | Isolated mode                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------- |
| `<a target=_top>` / `_parent`, `<form target>`, `<base target>`, `formtarget`, `window.open(u,'_top')` | blocked by sandbox (measured)                | blocked by sandbox (measured)           |
| `top.location = x`, `top[k] = x`, `top.location                                                        |                                              | = x`                                    | contained by rewriter (measured) | contained |
| `top.location.href = x`, `top.location.replace()`, `window.top...`, `window['top']`, `globalThis.top`  | contained (measured)                         | contained                               |
| `<a target=_blank>`, named targets, middle click, `window.open(u)`                                     | **bare proxied tab**, no host UI (measured)  | **bare proxied tab**, sandbox inherited |
| Dynamically inserted inline scripts                                                                    | now rewritten (measured)                     | now rewritten                           |
| `setTimeout('top.location = ...')`                                                                     | raw, stopped only by sandbox (measured)      | stopped by sandbox                      |
| `onclick="top.location = ..."` inline handlers                                                         | raw, stopped only by sandbox                 | stopped by sandbox                      |
| `javascript:` URLs                                                                                     | raw, stopped only by sandbox                 | stopped by sandbox                      |
| `<iframe srcdoc>` content                                                                              | raw, unproxied                               | raw, sandbox inherited                  |
| `const {top: t} = window; t.location.href = x`, `Reflect.get(window,'top')`                            | raw `top`, stopped only by sandbox           | stopped by sandbox                      |
| `opener.top.location = x` from a popup                                                                 | raw host window (`newRestricted` returns it) | popup inherits sandbox                  |
| `history.back()` at the frame's first entry                                                            | walks the host out                           | browser dependent, not measured         |
| Page calls `document.open()`                                                                           | drops the message filter and tagger          | same                                    |
| `<area href>`                                                                                          | never rewritten; raw URL in the frame        | same                                    |
| `blob:` navigations, `about:blank` popups written with `document.write`                                | unrewritten documents                        | same                                    |

What to do, in order of leverage:

1. Decide the popup policy. `allow-popups` is what turns `_blank` and
   `window.open` into bare tabs. Either drop it and convert `window.open` /
   `_blank` into a message to the controller ("open tab with URL") that the
   host honours (scramjet's `CatchEscapedLinksPlugin` does the equivalent by
   302-ing document fetches back to the shell), or keep it and never add
   `allow-popups-to-escape-sandbox`.
2. Rewrite `target` on `a`, `area`, `form`, `base`, `formtarget` on
   `button`/`input`, the `window.open` target, and wrap the returned
   WindowProxy with `newRestricted`. Map `_top`/`_parent` to `_self`.
3. Rewrite the remaining JS carriers: inline `on*` attributes, `javascript:`
   URLs (`routeURL.ts:97` returns them verbatim), string timers,
   `<iframe srcdoc>` (route through the `modifyHTML` shell with the parent
   URL as base).
4. Harden `Access.ts`: `set2` should wrap the `in` check in try/catch and
   substitute `client.global` for any non-Stomp window; `get` should return
   the own location proxy when the object is a foreign window's location;
   `newRestricted` should return `findTop(global)` for any non-Stomp window,
   not only `client.top` / `client.parent` (closes `opener.top`); spoof
   `opener`.
5. Destructuring of `top` / `location` (`ObjectPattern`, `ArrayPattern`),
   see section 3.
6. Hook `History.prototype.back/forward/go` to stay within the frame's own
   entries (reuse `src/controller/history.ts`).

## 3. JS rewriter

Scramjet: Rust/oxc to wasm, offset edit list, binary sourcemap, helper names
configurable. Stomp: meriyah parse, AST mutation, full regeneration with
escodegen (all comments lost, literals normalised).

| Feature                                                                                                                 | Status  | Notes / how                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Reads, member reads, computed reads of `top`/`location`/`eval`                                                          | ok      | value-tagged (`$s$L`) so aliases via rest/spread work; scramjet's `$scramjet$clean` is a stub        |
| `parent` read                                                                                                           | partial | runtime getter only; fine for a single frame                                                         |
| `location = v`, `location op= v`, `location++`                                                                          | ahead   |                                                                                                      |
| `x.location = v` for `document`, `top`, other windows                                                                   | partial | `set2` only redirects when target is `client.global`; treat any Window/Document the same             |
| Shorthand `{location}`                                                                                                  | missing | set `shorthand = false` when replacing a `Property.value`                                            |
| Alias / computed destructuring `const {location: x} = o`, `[top] = y`                                                   | missing | leaks the real object; scramjet rewrites keys to prototype accessors                                 |
| `var {location} = o` (sloppy, hits the real setter), assignment patterns                                                | missing | navigates the frame; needs temp bindings like scramjet's `TempVar`                                   |
| `for (location of ...)`                                                                                                 | missing | produces an invalid left-hand side                                                                   |
| `typeof top`                                                                                                            | missing | rewritten to `typeof $s$j.get(top,'top')`, throws in workers                                         |
| Skip list: class fields, `ClassExpression` id, `catch` param, labels, `super.x`, `Property.value` under `ObjectPattern` | missing | each one is a SyntaxError that kills the script                                                      |
| On parse failure return the original source (`allowInvalidJs`)                                                          | missing | Stomp emits `throw new SyntaxError`                                                                  |
| Bare import specifiers pass through to import maps                                                                      | missing | `new URL('react', base)` throws, whole module dies                                                   |
| `export * from` / `export {a} from` source rewriting                                                                    | missing |                                                                                                      |
| `import()` base is the script URL, not the document                                                                     | partial | bake the script URL in at rewrite time                                                               |
| `import.meta.resolve`                                                                                                   | partial | only `import.meta.url` is set                                                                        |
| Module workers                                                                                                          | missing | preamble is `importScripts(...)` for both worker types; undefined in `type: "module"` workers        |
| Preamble before `'use strict'` in workers                                                                               | partial | workers lose strict mode                                                                             |
| `eval(nonString)` returns a string                                                                                      | partial | `evalScope` does `String(code)`                                                                      |
| `GeneratorFunction`, `AsyncGeneratorFunction` constructors                                                              | partial | only `Function` and `AsyncFunction` are proxied                                                      |
| Optional chain through a non-optional member (`a?.b.location.c`)                                                        | partial | the `optional` flag is lost after the first link                                                     |
| Shadowing analysis                                                                                                      | parity  | neither does it; both pass the shadow test by identity / tagging                                     |
| `debugger` removal                                                                                                      | missing | anti-debug sites                                                                                     |
| Edit-map sourcemaps so `Function.prototype.toString` returns original code                                              | missing | `restoreJS` is identity; needs a splice-based emitter (meriyah already gives ranges) and an edit map |
| `//# sourceURL` / `sourceMappingURL` kept                                                                               | missing | all comments dropped                                                                                 |
| Configurable helper names (`$s$j`, `$s$L`, `$P$s` are fixed)                                                            | missing | fingerprintable                                                                                      |
| Debug flags: `captureErrors`, `scramitize`, `rewriterLogs`, `debugTrampolines`, `siteFlags`                             | missing |                                                                                                      |

Scramjet's native rewriter tests (`sj/core/rewriter/native/tests`): `0-sanity`,
`2-function-default` and `3-shadow-globals` pass on Stomp; `1-destructure`
fails to parse; `4-var-destructure-contexts` parses but every case navigates.

## 4. HTML and element attributes

Stomp has no server-side HTML pass: `modifyHTML` ships the raw document to the
page and `loadHTML` re-creates it through hooked `setAttribute`. So the hook
list below is the complete attribute rewrite list, and anything before the
inject bundle runs (no-JS user agents, crawlers, sandboxed frames without
`allow-scripts`) sees raw markup. `src/parse5Util.ts` is dead code.

| Rule (from `sj/core/src/shared/htmlRules.ts`)                                                                                                                              | Status       | Notes / how                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a[href]`, `img[src]`, `script[src]`, `iframe[src]`, `embed[src]`, `form[action]`, `video/audio/source[src]`, `img/source[srcset]`, `*[style]`, `base[href]`, `link[href]` | ok (runtime) |                                                                                                                                                                  |
| `area[href]`                                                                                                                                                               | missing      | image maps navigate raw                                                                                                                                          |
| `frame[src]`, `input[src]`, `track[src]`                                                                                                                                   | missing      | framesets, image buttons, subtitles                                                                                                                              |
| `object[data]`, `video[poster]`                                                                                                                                            | missing      |                                                                                                                                                                  |
| `button/input[formaction]`                                                                                                                                                 | missing      | multi-action forms post to the proxy origin                                                                                                                      |
| `link[imagesrcset]`                                                                                                                                                        | missing      |                                                                                                                                                                  |
| `link[rel]` tokenising and `as=` mapping (`modulepreload`, `preload as=script/style`, `"stylesheet preload"`)                                                              | partial      | exact `switch(rel)`; preloads get the binary route and are wasted or unrewritten                                                                                 |
| `script[type]` recognition (`text/ecmascript`, uppercase, whitespace, `language=`)                                                                                         | partial      | exact-match list; port scramjet's `isScriptType`                                                                                                                 |
| `iframe[srcdoc]`                                                                                                                                                           | missing      | runs raw HTML and JS                                                                                                                                             |
| `iframe[sandbox]` removal                                                                                                                                                  | missing      | a sandbox without `allow-same-origin` gives an opaque origin the SW does not control; without `allow-scripts` the shell never runs                               |
| `iframe[csp]`, `iframe[credentialless]` removal                                                                                                                            | missing      | `csp=` blocks the shell's inline script                                                                                                                          |
| `a/base[target]`                                                                                                                                                           | missing      | see section 2                                                                                                                                                    |
| SVG `href` / `xlink:href` on `image`, `use`, `textPath`, `mpath`, `feImage`, `animate*`, `set`, `discard`, gradients, `pattern`, `filter`                                  | missing      | sprite sheets 404; `setAttributeNS` is not hooked at all                                                                                                         |
| Inline `on*` handler attributes (102 of them)                                                                                                                              | missing      | run unrewritten                                                                                                                                                  |
| `<template>` contents                                                                                                                                                      | missing      | dropped by `cloneRawNode`                                                                                                                                        |
| `<style>` text rewritten before the browser parses it                                                                                                                      | partial      | Stomp rewrites the CSSOM after parse, so `@import` / `@font-face` fetches have already gone to the proxy origin, comments are lost and there is a FOUC per sheet |
| importmap `imports` / `scopes`                                                                                                                                             | missing      |                                                                                                                                                                  |
| `speculationrules` URLs                                                                                                                                                    | missing      | both lack it                                                                                                                                                     |
| `meta http-equiv=refresh` spec parser                                                                                                                                      | partial      | regex needs literal `url=`; `content="5; https://x"` misses                                                                                                      |
| Charset sniffing (BOM, header, 1024-byte prescan) and `charset=utf-8` normalisation                                                                                        | missing      | Shift_JIS / GBK / windows-125x pages are mojibake; the original header's charset is kept and wins                                                                |
| Standalone SVG / XHTML documents                                                                                                                                           | partial      | SVG is wrapped as HTML and loses its XML nature; XHTML passes through uninjected (both are weak)                                                                 |
| `hasAttribute`, `getAttributeNames`, `getAttributeNode`, `Attr.value`, `Element.attributes` hide `s_o:*`                                                                   | missing      | frameworks that diff attributes (Vue, Svelte, morphdom, Alpine) see and copy them                                                                                |
| `toggleAttribute`, `setAttributeNS`, `setAttributeNode`                                                                                                                    | missing      | bypass every hook                                                                                                                                                |
| `innerHTML` / `outerHTML` getters un-rewrite                                                                                                                               | missing      | serialise-and-reparse patterns double-route                                                                                                                      |
| `setHTMLUnsafe`, `getHTML`, `Document.parseHTMLUnsafe`                                                                                                                     | missing      | declarative shadow DOM                                                                                                                                           |
| `Range.createContextualFragment`, `DOMParser.parseFromString`                                                                                                              | missing      | parsed nodes carry raw attributes; insertion only processes scripts, styles and forms                                                                            |
| `script.textContent` getter returns the original source                                                                                                                    | partial      | only `document.currentScript.textContent` for parser-inserted scripts                                                                                            |
| `HTMLImageElement.currentSrc`, `HTMLAnchorElement.toString`                                                                                                                | missing      |                                                                                                                                                                  |
| `contentWindow` / `contentDocument` injection on `frame`, `object`, `embed`; `getSVGDocument`                                                                              | partial      | only `iframe`                                                                                                                                                    |
| `document.documentURI`, `document.domain` setter, `window.origin` / `self.origin`                                                                                          | missing      |                                                                                                                                                                  |
| `querySelector` attribute-selector rewriting (`a[href^="https://site"]`)                                                                                                   | missing      | selectors match nothing because the attribute holds the routed URL                                                                                               |
| `document.write` incremental tokenizer (tags split across calls)                                                                                                           | partial      | each call parsed as a complete fragment                                                                                                                          |
| Inline script escaping, `<base href>` + `baseURI` spoof, `rel=manifest` removal, `script type` set after `src`                                                             | ahead        |                                                                                                                                                                  |

## 5. CSS

| Feature                                              | Status     | Notes                                                                                     |
| ---------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `url()`, `@import`, `@font-face`, custom properties  | ok         | css-tree based; more correct than scramjet's regexes (comments and strings are skipped)   |
| `CSSStyleSheet.insertRule/replace/replaceSync`       | missing    | styled-components, emotion, constructable sheets (Lit) load `url()` from the proxy origin |
| `CSSRule.cssText` set/get                            | missing    |                                                                                           |
| `CSSStyleValue.parse`, `StylePropertyMap.set/append` | missing    | Typed OM                                                                                  |
| `FontFace` constructor                               | missing    | `new FontFace('F', 'url(/f.woff2)')` 404s                                                 |
| `getPropertyValue` / `getComputedStyle` un-rewrite   | partial    | read-modify-write re-routes                                                               |
| `@namespace url()` left alone                        | both wrong | both rewrite it                                                                           |
| `modifyCSS` parse failure                            | partial    | throws, whole `/css/` response rejects; fall back to the raw URL regex                    |
| `data:` CSS decoded with `atob`                      | partial    | mangles non-Latin1; use `TextDecoder`                                                     |

## 6. Requests, headers, cookies

| Feature                                                                                                                                                 | Status       | Notes / how                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Referer honouring the 8 referrer policies                                                                                                               | partial      | always full URL; and when the site's `Referrer-Policy` strips it, `Referer` and `Origin` vanish (API 403s). Scramjet forces `Referrer-Policy: unsafe-url` on documents and uses `clients.get(clientId)` |
| `Origin` on CORS GETs                                                                                                                                   | partial      | only set for non-GET                                                                                                                                                                                    |
| `Sec-Fetch-Site/Mode/Dest/User` recomputed from unrewritten URLs                                                                                        | partial      | browser values copied; `Dest` is `''` for `fetch()`                                                                                                                                                     |
| `fetch` `mode` / `credentials` forwarded                                                                                                                | missing      |                                                                                                                                                                                                         |
| Request body streamed                                                                                                                                   | partial      | `await request.blob()` buffers uploads                                                                                                                                                                  |
| Abort / timeout propagation                                                                                                                             | both missing | a hung wisp socket hangs forever                                                                                                                                                                        |
| HTTP cache (RFC 9111) in front of the transport                                                                                                         | missing      | scramjet `HttpCachePlugin`; every reload re-downloads everything over wisp                                                                                                                              |
| Hook points around forward / response (Tap)                                                                                                             | missing      | nowhere to plug a cache, a request viewer, blocking or header injection                                                                                                                                 |
| Strip `Clear-Site-Data`, `Set-Cookie`, COEP, HSTS, `Report-To`/NEL, `Permissions-Policy`, `X-Content-Type-Options`                                      | missing      | see section 1 for the two dangerous ones                                                                                                                                                                |
| Rewrite `Link` and `Content-Location` headers                                                                                                           | missing      | `Link: <...>; rel=preload` fetches the real origin directly                                                                                                                                             |
| Force `text/event-stream` when SSE is requested                                                                                                         | missing      |                                                                                                                                                                                                         |
| `Refresh` header, route-preserving `Location`, `Content-MD5` removal, `frame-ancestors`, HTML/JSON error pages, request queueing while the server boots | ahead        |                                                                                                                                                                                                         |
| Cookie matching: label-boundary domain walk, hostOnly, path boundary, SameSite                                                                          | partial      | `('.'+host).endsWith(domain)` and `startsWith(path)`; loads every cookie on every request                                                                                                               |
| `Max-Age` in seconds, `Max-Age<=0` deletes                                                                                                              | missing      | see section 1                                                                                                                                                                                           |
| `__Host-` / `__Secure-` prefixes, 4096-byte cap, CTL rejection                                                                                          | missing      |                                                                                                                                                                                                         |
| HttpOnly cookies on WebSocket handshakes                                                                                                                | missing      | `pageCookies` filters them                                                                                                                                                                              |
| `document.cookie` seeded into the page (local read) instead of a sync round trip                                                                        | partial      | every read spins the main thread                                                                                                                                                                        |
| `cookieStore` removed from pages                                                                                                                        | missing      | pages see proxy-origin cookies including the sync bridge chunks                                                                                                                                         |
| Sync XHR bridge                                                                                                                                         | ahead        | works (scramjet's SAB design is disabled); bodies are text-decoded (binary corrupted), headers flattened                                                                                                |
| `blob:` routed through the SW                                                                                                                           | missing      | blob workers (pdf.js, Monaco, ffmpeg.wasm) start uninjected; `createObjectURL` leaks the proxy origin                                                                                                   |
| `data:` percent-decoding                                                                                                                                | partial      | `data:text/html,%3Cscript%3E...` rewritten as literal text                                                                                                                                              |
| Decoded URL equals proxy origin guard                                                                                                                   | missing      |                                                                                                                                                                                                         |
| XHR `responseType` json/blob/document, `responseXML`, `timeout`, `upload`                                                                               | partial      |                                                                                                                                                                                                         |
| `WebSocketStream`                                                                                                                                       | missing      | delete it so sites fall back                                                                                                                                                                            |

## 7. Storage, workers, messaging, realms

| Feature                                                                                                                            | Status  | Notes / how                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `localStorage` / `sessionStorage` per origin                                                                                       | ahead   | server-side in IDB with a `Storage` mirror (scramjet prefixes keys in the real storage)                                            |
| `storage` events                                                                                                                   | missing | none fire; cross-tab auth sync (Auth0, Firebase, Supabase) never happens. Broadcast from the SW, dispatch synthetic `StorageEvent` |
| `indexedDB` name scoping                                                                                                           | partial | `name` getter bug; `deleteDatabase` / `databases()` not hooked                                                                     |
| `caches.*` scoping and `match` URL rewriting                                                                                       | missing | all proxied sites share one CacheStorage                                                                                           |
| OPFS `getDirectory` per-origin subdirectory                                                                                        | missing |                                                                                                                                    |
| `SharedWorker`                                                                                                                     | missing | loads an unrewritten script from the proxy origin                                                                                  |
| `Worklet.addModule`                                                                                                                | missing | AudioWorklet / PaintWorklet 404                                                                                                    |
| Per-worker transport ports (WebSockets inside workers)                                                                             | ahead   | scramjet workers have `transport: null`                                                                                            |
| `self.location` / `self.origin` in workers                                                                                         | missing | already in known limitations                                                                                                       |
| `BroadcastChannel` name prefixing and origin tagging                                                                               | missing | two proxied sites with the same channel name talk to each other                                                                    |
| `MessageEvent.source` returns a restricted window                                                                                  | partial | real WindowProxy of cross-site proxied frames is exposed                                                                           |
| Message tagger registered in `apply()` not only on `document.open`                                                                 | missing | about:blank frames see the envelope                                                                                                |
| `Document.prototype.open` re-registers window listeners                                                                            | missing |                                                                                                                                    |
| `window.open` return value hooked, about:blank popups injected                                                                     | missing |                                                                                                                                    |
| `frameElement` returns the real element for nested proxied frames                                                                  | partial | always null                                                                                                                        |
| Cross-realm constructors (`Text`, `Element`, `DOMParser` as free globals in `cloneNode.ts`)                                        | partial | nodes from a child realm fail `instanceof` and are skipped                                                                         |
| `hashchange` `oldURL` / `newURL` un-rewrite                                                                                        | missing |                                                                                                                                    |
| `history.pushState` same-origin check                                                                                              | partial | a cross-origin pushState lands the frame on another site                                                                           |
| `PerformanceEntry.name` un-rewrite, inject bundle entries filtered                                                                 | missing | RUM sees routed URLs                                                                                                               |
| `Error.prepareStackTrace` cleaning, `maskedfiles`                                                                                  | missing | Sentry sees routed URLs and `injectDocument.js` frames                                                                             |
| `registerProtocolHandler` no-op                                                                                                    | missing |                                                                                                                                    |
| Delete the Navigation API (`window.navigation`)                                                                                    | missing | routers read `navigation.currentEntry.url` as the routed URL                                                                       |
| Delete Chrome-only APIs (Bluetooth, HID, Presentation, ...)                                                                        | missing | cheap optional module                                                                                                              |
| `console.clear` no-op (anti-anti-debugger)                                                                                         | missing | cosmetic                                                                                                                           |
| Cross-site frame isolation with real `DOMException`s, `ancestorOrigins`, framing spoof, deleting the `ServiceWorker*` constructors | ahead   |                                                                                                                                    |

## 8. Controller, config, plugins

| Feature                                                                                                                                                 | Status  | Notes / how                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| Multiple controllers per origin (random id prefix)                                                                                                      | missing | one controller per `directory`; a second host tab replaces the first in the SW        |
| Per-frame prefix / identity                                                                                                                             | missing | needed for per-frame hooks and plugins                                                |
| `Frame.hooks.init.pre/post` (run host code inside a proxied realm)                                                                                      | missing | every scramjet utils plugin builds on this                                            |
| `Frame.hooks.fetch.intercept/request/preresponse/response`                                                                                              | missing | request viewer, cache, blocking                                                       |
| `Frame.hooks.error.request` (host replaces the error page)                                                                                              | missing |                                                                                       |
| `client.hooks.lifecycle.navigate` (push URL changes to the host)                                                                                        | missing | Stomp polls `frame.url` every 500ms                                                   |
| Cookie jar reachable from the host (`dump`, `clear`, import)                                                                                            | missing | add an RPC to the SW store                                                            |
| Version pin between `serviceWorker.js`, inject bundles and controller                                                                                   | missing | partial deploys fail silently                                                         |
| Pluggable codec functions                                                                                                                               | partial | Stomp has four keyed codecs instead (ahead on unguessability, behind on pluggability) |
| Configurable paths for bundles                                                                                                                          | partial | fixed `${directory}injectDocument.js` etc                                             |
| Flags: `syncxhr`, `cleanErrors`, `sourcemaps`, `allowInvalidJs`, `allowFailedIntercepts`, `destructureRewrites`, `siteFlags`, `maskedfiles`, dev preset | missing |                                                                                       |
| Plugins: `HttpCachePlugin`, `UrlWatcherPlugin`, `CatchEscapedLinksPlugin`, `LinkHandlerPlugin`, `EventHandlerPlugin`                                    | missing | see sections 2 and 6                                                                  |
| SW as a composable library (`shouldRoute` / `route` for an existing PWA SW)                                                                             | partial | Stomp's worker is standalone                                                          |
| `back()` / `forward()` bounded to the frame's own history, `canGoBack`, `title`, `url`                                                                  | ahead   |                                                                                       |
| `RemoteController`, sandbox option, `frameAncestors`, `pollInterval`                                                                                    | ahead   |                                                                                       |

## 9. Tooling, tests, scaffolding

| Feature                                                                                                                                                                                                                     | Status  | Notes                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Runway: Playwright test runner, `basicTest` / `htmlTest` / `serverTest` / `multiFrameTest` builders, differential "bare" harness, in-page assert helpers, expected-failure list, parallel workers, coverage, `inspect` mode | missing | Stomp has no test suite; AGENTS.md prescribes manual probes                            |
| ~60 test files (28 adversarial, cookies, eval, postmessage, referer, websockets, wpt, site tests for google/youtube)                                                                                                        | missing | the probes written for this document (fixture server + Playwright) are the seed of one |
| WPT vendoring (cookies, fetch-metadata, referrer-policy)                                                                                                                                                                    | missing |                                                                                        |
| Rewriter unit tests (`cargo test`, native test files)                                                                                                                                                                       | missing | `modifyJS` can be bundled with esbuild and run under node in a second                  |
| Dev server escape detection (warn on unproxied hits to the prefix)                                                                                                                                                          | partial | `--host-resolver-rules` instead                                                        |
| `create-proxy-app` scaffolding, `proxy-bootstrap` server, static bootstrap                                                                                                                                                  | missing | `demo/` is the reference integration                                                   |
| Demo: flag editor, request viewer, playground with a virtual origin                                                                                                                                                         | missing | no flags or taps to drive them                                                         |
| Demo: multiple tabs with live previews, TLD autocomplete, isolation toggle, console badges                                                                                                                                  | ahead   |                                                                                        |
| CI: package validation, release pipeline                                                                                                                                                                                    | partial | Stomp CI has lint, types, format, prose, build, pinned actions, deploy gate; no tests  |

## 10. Suggested order of work

1. Correctness bugs that break logins and whole scripts: cookie `Max-Age`,
   the rewriter skip list and return-original-on-failure, shorthand
   `{location}`, bare imports and `export from`, `<template>`, charset
   sniffing, `fetch(Request)`, `IDBDatabase.name`, `location.reload`.
2. Isolation: popup policy and `target` / `window.open` rewriting, inline
   `on*` handlers, `javascript:` URLs, string timers, `srcdoc`, `Access.ts`
   hardening, destructuring of unforgeables.
3. CSS-in-JS and fonts: `insertRule` / `replace`, `FontFace`, `<style>` text
   rewritten before parse.
4. Frameworks: attribute-marker hiding, `innerHTML` getter un-rewrite,
   `querySelector` attribute selectors, `setAttributeNS` and SVG hrefs,
   `DOMParser` / `createContextualFragment`.
5. Cross-tab and storage: `storage` events, `BroadcastChannel`, `caches`,
   OPFS, `SharedWorker`, `Worklet`, module workers, `blob:` routing.
6. Headers: strip `Clear-Site-Data` / `Set-Cookie` / COEP / HSTS, rewrite
   `Link`, `Origin` on CORS GETs, referrer policy via `clientId`.
7. Infrastructure: a Tap-like hook chain in `genericForward`, HTTP cache,
   streamed request bodies, abort propagation, a version pin, lifecycle
   events pushed to the host, a cookie-jar RPC.
8. Tests: turn `/tmp/stomp-probe`-style fixture plus Playwright into a
   checked-in suite, port scramjet's rewriter test files, then its
   adversarial suite one file at a time.
