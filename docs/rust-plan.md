# The Rust rewriter and the built-in blocker

The plan for moving the slow half of STomp (the JS rewriter first, then the
CSS and markup scanners) from meriyah and escodegen to Rust compiled to
wasm, mirroring scramjet's rewriter where it is right, and for the built-in
blocker built from adblock-rust. Written 2026-11-10 against master a8a457b.

Nothing here lands all at once. Every phase keeps the JavaScript rewriter as
the fallback, is chosen by one option, and passes the full suite set on its
own.

## 1. Why

Measured today (see the speed notes in the project memory):

| Where                       | Cost                                                       |
| --------------------------- | ---------------------------------------------------------- |
| Discord's 13 MB `web.js`    | 3.5 s in one rewrite worker, 1.5 s split across four       |
| YouTube's `kevlar_base`     | 2.5 s, plus 0.9 s for a cold split plan                    |
| CNN's 3.47 MB inline script | parse 188 ms, print 247 ms, 728 ms in all                  |
| escodegen                   | 20 to 35% of a large rewrite; GC another 21%               |
| Per proxied frame           | about 1.4 MB of JS heap over native, 70% of it bundle eval |
| The rewriter library realm  | 223 KB of heap, the meriyah unicode table 272 KB alone     |

A JavaScript splice printer was tried and was slower (parked on
`wip/splice-print`), so the remaining lever is the language, not the
algorithm. The same move also gets the per-frame cost down: one wasm
instance in the shared library realm replaces the parser, the printer and
their tables.

## 2. What mirrors scramjet, and what does not

Read from `~/src/scramjet/packages/core/rewriter` (oxc 0.95, `ast_visit`
only: no semantic pass, no codegen).

Copied:

- the shape: parse, walk, collect text edits at spans, splice them into the
  original bytes at the end. No AST printing anywhere.
- one allocator per rewriter, reset after each call.
- the build profile: `lto`, `codegen-units = 1`, `panic = "abort"`, nightly
  with `-Z build-std`, `-Zlocation-detail=none -Zfmt-debug=none`, then
  `wasm-snip` of the TypeScript and JSX parser paths and a wasm-opt chain.
  Scramjet lands at 586 KB, 156 KB brotli, no SIMD. That is our size budget.
- the coverage proc macro, which fails the build when a visitor method can
  exit without walking a field whose type can reach an `Expression`. It is
  the only mechanical proof that a rewriter does not silently skip a
  construct, and STomp's transformation table is larger than scramjet's.
- the round trip invariant: an edit log that replays to the input.

Not copied (bugs confirmed in that tree):

- `new WebAssembly.Module` on every rewrite.
- a rewriter left poisoned by an early return (its change list never
  restored).
- `Box::leak` per destructuring.
- `from_utf8_unchecked` on network bytes.
- the UTF-8 against UTF-16 offset mismatch in the `toString` reversal.
- fixed width spans for `import(` and `eval`, which break on comments and
  whitespace between the token and the paren.
- `visit_object_expression` returning after the first shorthand property.
- every realm compiling its own module.
- the config re-marshalled on every call (13 `Reflect.get` calls per
  rewrite).
- a flat sorted edit list that cannot express nested edits (section 4).

HTML and CSS stay out of scramjet's Rust entirely (htmlparser2 and regexes
in JS). STomp's CSS rewriter already emits an edit list and already parses
lazily, so it is a better fit for Rust than scramjet's is; see phase 3.

## 3. Crates and layout

A workspace under `rust/`, built in a container by `deploy/rust/` the way
`deploy/epoxy/` builds epoxy:

```
rust/
├── Cargo.toml          workspace, the release profile; Cargo.lock committed
├── edits/              the span edit model and the splice engine (no oxc AST)
├── rwjs/               the JS rewriter: abi.rs (the wasm boundary, wasm32
│                       only), rewrite.rs (oxc parse, the prologue, lead and
│                       holder), walk.rs (the visitor: every rewrite family
│                       as edits), shape.rs (what is declined), config.rs,
│                       source.rs (function marks and keys), abi.json (what
│                       the artifact may import and export)
├── rwcss/              the CSS and markup scanners, one module (phase 3)
├── block/              adblock-rust wrapped for the service worker (phase 4)
├── rtc/                WebRTC over wisp (the other agent's crate, wasip1)
├── coverage-macro/     the build time walk proof
└── host/               Node scripts: parity.mjs (the differential harness and
                        its timings), cases.mjs (every family by shape),
                        cases.revision (the module's revision and outputs)
deploy/rust/
├── Dockerfile          the image: rust by digest, binaryen and wasm-bindgen
│                       by checksum, wasm32-unknown-unknown and wasm32-wasip1
├── pins.env            every version and checksum that goes in
├── build.sh            builds one crate in the container into assets/
├── compile.sh          what runs inside: build-std, wasm-opt, strip
├── check.mjs           the artifact checks (sections, abi.json, tokens)
├── test.sh             cargo test in the container
└── README.md
```

The toolchain is pinned by the image digest rather than a
`rust-toolchain.toml`: the pins in one file, and no toolchain download at
build time.

Three artifacts, built separately so a deployment that wants none pays for
none:

- the rewriter module: 426,993 bytes, 151,391 brotli as built with every
  rewrite family in (the budget is 600 KB, 160 KB brotli).
- the scanner module (`scanner.wasm`, phase 3): 25 KB, 11 KB brotli. It has
  no dependencies and shares no code with the rewriter, so it is a module of
  its own and not 25 KB more of the rewriter's.
- the blocker module, 1,063 KB, 299 KB brotli (the crate's regex and idna
  tables dominate).

All are committed under `assets/` with a `.sha256` and an `UPSTREAM` file
naming the toolchain and crate versions that produced them, and `build.js`
copies them into `dist/` as it copies `controllerFrame.html` (with a watch
of their own in dev mode, since esbuild watches only what it bundles). They
have to be in the published npm package: unlike epoxy, there is no separate
repository to pin by `git+https://`, and CI, the deploy and terp all run
`npm ci --ignore-scripts && npm run build` with no Rust toolchain and wipe
`dist/` on every build. Each gets a key in `Assets` and `DEFAULT_ASSETS`
(`src/config.ts`) so a host that renames files can name them, and its URL is
built from `assetBase` like the inject bundles' (`src/routeURL.ts`): the
service worker answers nothing at the scope's own level, so the file is
served by the host like every other asset in `dist/`, and the demo's
existing `/stomp/` mount serves it with no change.

## 4. The edit model

An edit is a span plus text. The text is built from three things: fixed
helper strings, a slice of the input, and a decimal number. Nothing is
printed from an AST.

STomp's rewrites nest (`$s$j.get2($s$j.get(location, "location"), k,
"...")`), so the engine cannot be scramjet's flat sorted list, which refuses
spans inside spans. The model:

- `Wrap { span, before, after }`: insert at `span.start` and at `span.end`.
  Everything inside the span is still visited and edited.
- `Replace { span, text }`: the span's bytes are replaced. No edit may fall
  strictly inside a replaced span, and the builder asserts it.
- `Insert { at, text, order }`: a point insertion. `order` breaks ties when
  two insertions land on one offset (a function mark against a wrap's
  opening paren).

Edits are sorted by `(start ascending, end descending, order)` and applied
by one recursive pass, so a properly nested set splices in one walk over the
input with no copying of the tail. An improperly nested set is a bug in the
visitor and fails the rewrite, which falls back to the JavaScript rewriter
for that script and counts a tell-free warning.

The arguments the helpers take as text (`generatePartial`, `callText`,
`sourceOf` in `src/rewriteJS.ts`) are already slices of the original script
wherever the node has a range, so in the Rust rewriter they are always
slices, JSON escaped. `src/callPrinter.ts` parses that text again when
something throws, so the error messages do not change.

### Which rewrites are expressible, and the hard ones

Every family in the table at `src/rewriteJS.ts:575-1494` wraps or replaces a
contiguous source range:

- identifier reads and writes (`get`, `set1`, `ref1`), member forms (`get2`,
  `set2`, `call2`, `call3`, `method`, `lazy`, `new2`, `fcall`, `fnew`,
  `ref2`), `in` to `has`, `import()` to `import`/`imported`/`importRoute`,
  static import routing, `postMessage` to `post`/`poster`, direct `eval` to
  `isEval`/`evalScope`, `debugger` to nothing, destructuring to
  `pattern`/`iter`/`coerce`: all wraps with a replaced key or a spliced
  argument list.
- the `with { type }` form of `import()` becomes an arrow wrapper around the
  specifier and the options, which is still a wrap of the whole call.
- top level `var location` in a classic script needs statements added after
  the declaration: a wrap of the declaration plus an insertion, no
  reordering.
- destructured parameters are hoisted into the body today by rebuilding the
  function. As edits: the parameter span is replaced with a temporary name
  and a `var` declaration is inserted after the body's directive prologue.
- the optional chain family is the hard one. It replaces a member expression
  with `$s$j.lazy(obj)?.(key)` and marks the rest of the chain optional,
  which means inserting `?.` at offsets inside _other_ nodes' spans. Those
  are point insertions at the punctuation between links, so they are
  expressible, but they are the easiest place to get wrong. They get their
  own differential corpus (the `optional-chains` suite plus generated cases)
  and the coverage macro covers the chain nodes.

Anything a phase has not yet proved is left to the JavaScript rewriter per
script, so a partial Rust rewriter is still safe to land.

## 5. The output contract

The output is no longer what escodegen printed. The new contract, which the
tests assert:

1. **Untouched bytes are identical.** Every byte of the input that no edit
   covers appears in the output unchanged, in order. Comments, whitespace,
   literal spelling, BigInt literals, regular expression bodies, template
   text: all preserved. (This removes a whole class of past bugs: escodegen
   printed BigInts as Numbers and dropped every comment.)
2. **The directive prologue stays first.** Nothing is inserted before the
   last directive of a prologue. The preamble, the holder statement and the
   worker bootstrap go immediately after it, in that order, as today.
3. **Function marks are unchanged.** `/*key.start36.len36*/` after the first
   token of each function of the page's, as `src/functionSource.ts` defines
   it, with the offsets taken from the input text. Since the kept text _is_
   the input, the offsets are exact rather than reconstructed. The offsets
   are UTF-16 code unit indices (`originalSource` slices the kept text as a
   JavaScript string) while oxc's spans are byte offsets, so every mark goes
   through a byte-to-UTF-16 conversion (`rust/rwjs/src/source.rs`); the key
   is the same two hashes over the UTF-16 code units, pinned to the
   TypeScript's values in its tests.
4. **Line and column positions improve.** An unedited line keeps its line
   number; a column shifts only by the edits earlier on that line. Today
   escodegen reprinted everything, so a stack position was only near the
   page's own. Tests that assert "near" are tightened, not loosened.
5. **`//# sourceURL` and `//# sourceMappingURL` keep their place**, and the
   mapping URL is still routed (a replace edit over the URL in the comment).
6. **`compact` stops meaning anything.** Splicing never reformats, so
   minified code comes back minified by construction. The argument stays in
   the JavaScript API for the JavaScript backend; the wasm backend ignores
   it.
7. **A split part is the JavaScript rewriter's, and under `'wasm'` nothing
   is split.** The split exists because one worker took 3.5 s over Discord's
   bundle. The module takes the same 12 MB whole in 0.43 s, less than the
   0.9 s the split plan's own parse costs, so the pool does not split a
   script when its thread holds the module (`RewritePool.#split`), and a
   part (`compact` given) is never handed to the module: its output is
   stitched into the whole by what the printer makes of it. `splitSources`
   and `stitch` are unchanged and serve the JavaScript backend.
8. **Prewritten bare output equals the plain rewrite**, as today, and
   `packRewrite` keeps working because the preamble and holder are still
   contiguous inserts at a known offset.
9. **Semantics, V8 error messages and `Function.prototype.toString` are
   native equivalent.** Not "equal to the old output": equal to what a
   native browser would do.
10. **Output is valid UTF-8 and never splits a code point.** Edits are
    placed at token boundaries from oxc spans, which are byte offsets into
    validated UTF-8. The host side never calls `from_utf8_unchecked` on
    network bytes: the ABI takes bytes and validates once, and a script that
    is not UTF-8 falls back to the JavaScript rewriter.

## 6. The boundary and loading

### The ABI

Hand written glue, not wasm-bindgen. Three reasons: the artifact must survive
being renamed and byte substituted by a host's build pipeline (section 7),
wasm-bindgen bakes its own module filename into the glue as a string, and the
whole boundary here is byte buffers.

Exports (short, neutral, and renamable by the host because the glue reads
them from a table it is given):

| Export   | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| `memory` | the memory                                                    |
| `a`      | `alloc(len) -> ptr`                                           |
| `f`      | `free(ptr, len)`                                              |
| `c`      | `configure(ptr, len) -> status`, the config once per change   |
| `r`      | `call(ptr, len, flags) -> status` (0 ok, otherwise a decline) |
| `p`      | the result pointer                                            |
| `n`      | the result length                                             |
| `b`      | the scratch the host answers a routing call in (64 KiB)       |

One import: `e.r(kind, ptr, len) -> len`, which the host answers by writing
a routed URL into the scratch (-1 when the text does not route). Kind 1 is
a static import or re-export source (the `with { type }` value by its
length, then the specifier), kind 2 a source map's URL, kind 0 the
boundary's own echo. URL routing stays in TypeScript (`StompURL`, the
codecs, `routeURL.ts`): duplicating it in Rust would be a second source of
truth for the thing most likely to leak an origin.

The flags of `r`, and what each call takes and answers:

| Flag | Input                          | Answer                                    |
| ---- | ------------------------------ | ----------------------------------------- |
| 0    | a classic script               | the rewritten script                      |
| 1    | text                           | the host's routing of it (the round trip) |
| 2    | a module                       | the rewritten module                      |
| 4    | (with 0 or 2)                  | the holder statement is written too       |
| 8    | `url`, `key`, `shifts`, `lead` | nothing: they hold for the next rewrite   |
| 16   | nothing                        | `marks<TAB>key` of the last rewrite       |
| 32   | nothing                        | the revision of what the module writes    |
| 64   | a classic script               | `1` when it parses, `0` when not          |
| 128  | a classic script               | `1` when it is one expression statement   |

`lead` is what runs before the script's own code (the worker bootstrap, a
module's `import.meta` lines, the caller's preamble), built by `scriptLead`
in `src/rewriteJS.ts` for both backends; the module places it after the
directive prologue. A status other than 0 is a decline, and the caller runs
the JavaScript rewriter on that script: 1 the configuration or the params
are malformed, 2 a URL did not route, 3 the input is not UTF-8, 4 oxc did
not parse it, 5 a shape left to the JavaScript rewriter (`shape.rs`), 6 the
edits did not nest. Status 7 is no decline: the script is one no browser
runs (below), and the host answers it as the JavaScript rewriter answers
what it cannot parse (`unrewritten` in `src/wasm/rewriter.ts`: the script as
it was, or a `throw` under `allowInvalidJs: false`) without running that
rewriter. Flags 64 and 128 ask the parser alone, for `parsesAsScript` and
`singleExpression`, whose answer is the module's wherever the thread holds
it. The revision (`REVISION` in `rewrite.rs`) is raised
whenever the output for any script changes, so a cache of rewrites keyed on
the backend and the revision never serves an older module's text;
`rust/host/parity.mjs --cases` holds it to the outputs
(`rust/host/cases.revision`).

`configure` is called once when the config changes, never per rewrite: the
helper names, the routed name list, the flags and the directory cross once.
The payload is lines of `key<TAB>value`, not JSON: every value is an
identifier, a URL or a flag, a JSON parser is a measurable share of the
artifact, and the host side builds the text from the config it already has.
The host side of the rewriter is `src/wasm/rewriter.ts` (`rewriteInWasm`,
which `modifyJS` tries first under `rewriter: 'wasm'`).

`panic = "abort"` means a Rust panic is a wasm trap. The glue treats a trap
as "this instance is dead": it drops the instance, keeps the compiled module,
and falls back to the JavaScript rewriter for that script.

### One module, many realms

`WebAssembly.Module` is structured cloneable and can be posted to a worker in
the same agent cluster. A service worker is not in the controller's: it is
an agent cluster of its own, and a message holding a module reaches it as a
`messageerror` with no data (measured, Chrome 152), which in the handshake
would lose the controller. So:

- the controller loads the module's bytes once and compiles them once. It
  posts the compiled module to every rewrite worker, and the bytes to the
  service worker with the handshake (`ControllerInitMessage.modules`, or
  `CONTROLLER_MODULES` when the load finished after it).
- the service worker compiles the bytes on its own thread (once: the same
  bytes from another handshake are the module it has) and keeps one instance.
- each rewrite worker keeps one instance.
- in the page, the instance lives in the shared rewriter library realm
  (`src/inject/dom/rewriterRealm.ts`), which a top makes once and its frames
  share. A frame never instantiates anything: it already speaks to that
  realm in strings only, synchronously, through its top's client. A document
  with no shareable top (a sandboxed frame without `allow-same-origin`, a
  worker) holds no module yet and keeps the JavaScript library copy it
  evaluates today (phase 2, below).

How the page's realm gets the module, given how that realm is made: the top
evaluates the library's own source text in an about:blank frame and removes
the frame in the same task, so the library can name nothing of the outer
bundle and its DOM globals are captured while it is still attached
(`src/libGlobals.ts`). Two consequences:

- the module's bytes are never inlined into the library text. The text is
  embedded in `injectDocument.js` and counts against its 850 KB budget, and
  600 KB of base64 would blow it. The module is handed in.
- `WebAssembly` joins the globals the library captures from the realm, and
  the client hands the realm a compiled `WebAssembly.Module`, not bytes:
  instantiation is synchronous and cheap (`new WebAssembly.Instance`), while
  a synchronous compile of a 600 KB module on the main thread is what Chrome
  limits, and a compile in the page's realm would also answer to the page's
  own Content-Security-Policy. The top asks for it: when it has made its
  library realm it posts a port to the service worker (`INIT_PAGE_MODULES`),
  the worker passes the port to the document's controller (`pageModules`),
  and the controller answers on it with the modules it compiled
  (`PAGE_MODULES`). The worker only forwards the port: the module travels
  between the controller and the page, which are one agent cluster (a
  `WebAssembly.Module` clones within it, and the controller and the proxied
  frames share the proxy origin in both modes). The library takes it through
  `adopt(name, module)` (`src/rewriterLib.ts`), the one object that crosses
  into the library, and only inward: the library reads nothing of it, it
  instantiates it. Until it has arrived, and in any realm it cannot reach (a
  tab opened with `noopener` is another agent cluster and hears a
  `messageerror`), the JavaScript backend answers: the inject's rewrites are
  synchronous, and a script that needs rewriting before the module is there
  cannot wait for it. That is the same per-script fallback the workers use,
  so a document whose first inline script runs before the module lands is
  rewritten correctly, just by the slower backend.

The rewrite workers hold no config between requests today (every
`RewriteRequest` carries the whole config). The worker keeps the last
config's JSON, as `src/rewriterLib.ts`'s `enter` does, and calls `configure`
only when it changes, so the once-per-change rule holds without a new
message. The rewrite cache keys on the config, so the backend choice becomes
part of the key on its own, as it must: the two backends' outputs differ.

Per-frame cost therefore goes down, not up, once the JavaScript libraries
leave the inject bundle: that is a goal of phase 2 with a number on it, set
out under "The inject bundle without the JavaScript libraries" below. The
`frame-cost` ceiling (1,120 KB of heap per frame, `injectDocument.js` at
most 850 KB) is a gate on every phase until then.

### Instance memory

wasm linear memory never shrinks. A 13 MB script will grow an instance to
tens of megabytes and keep it. Three mitigations, all measured in phase 1:

- `Allocator::reset` after every rewrite, as scramjet does.
- an instance that has grown past a threshold is dropped and replaced
  (cheap: the module stays compiled).
- the service worker's instance is dropped when it has been idle, so a
  long-lived worker does not hold a Discord-sized heap.

Measured (Node 24, the artifact above, one instance per row):

| State of the instance                    | Linear memory |
| ---------------------------------------- | ------------- |
| fresh                                    | 1,152 KB      |
| after a script of a few lines            | 1,344 KB      |
| after one 280 KB script                  | 5,056 KB      |
| after one 1.2 MB script                  | 26,752 KB     |
| after one 3.5 MB script                  | 56,128 KB     |
| after one 12 MB script (Discord)         | 204,288 KB    |
| after the whole 46 MB corpus, one by one | 247 MB        |

Of the fresh 1,152 KB, 1 MB is the stack the linker reserves; pages nothing
has touched are not committed by the system. The second mitigation is built
(`MEMORY_LIMIT` in `src/wasm/thread.ts`: past 64 MB the instance is dropped
after the call, so Discord's bundle costs its 204 MB for one rewrite and
then nothing); the idle drop in the service worker is not, and the 64 MB
threshold is the workers': the page's instance wants a lower one (phase 2).
Compiling the module takes 21 ms off the main thread and instantiating it
0.2 ms.

### The inject bundle without the JavaScript libraries

The goal of phase 2, and part of its definition of done: once the wasm
rewriter serves the inject's paths, meriyah, escodegen and css-tree come out
of `dist/injectDocument.js`, and the public suffix lookup moves into a wasm
module so tldts leaves it too. Every proxied frame loads that bundle; the
libraries are half of it and no frame under a top ever runs them.

What they weigh, measured on master bf1f9b3 (the production build, which is
what ships: `dist/injectDocument.js` is 814,491 bytes, 210,703 brotli; the
1,907,421 bytes the dev server serves are the same bundle unminified). The
rewriter library embedded in it is 464,076 bytes, by esbuild's metafile:

| In the library                       | Bytes   |
| ------------------------------------ | ------- |
| tldts (and tldts-core)               | 131,888 |
| meriyah                              | 120,153 |
| escodegen (with esutils, estraverse) | 75,033  |
| css-tree                             | 69,014  |
| STomp's own rewriters on them        | 46,669  |
| crypto-js (the codecs; stays)        | 18,632  |

And the bundle built with each stubbed out (the same build, the package
resolved to an empty module), which is what leaving it is worth:

| Build             | `injectDocument.js` | Saved   |
| ----------------- | ------------------- | ------- |
| master            | 814,491             |         |
| without tldts     | 682,600             | 131,891 |
| without meriyah   | 694,134             | 120,357 |
| without escodegen | 737,934             | 76,557  |
| without css-tree  | 745,621             | 68,870  |
| without all four  | 415,585             | 398,906 |

Without the four the bundle is 49% smaller (108,951 brotli against
210,703). `dist/injectWorker.js`, which carries meriyah and escodegen only,
goes from 427,037 to 230,261.

**The target.** `dist/injectDocument.js` at most 415,585 bytes (406 KB as
the suite counts, 1,024 to the KB): the stub build's size, which the real
removal should beat, since `rewriteJS.ts`, `callPrinter.ts`, `acornUtil.ts`
and `builders.ts` (35 KB of the 46,669) leave with their parsers and the
wasm glue that replaces them is under 4 KB. The `frame-cost` suite's bundle
budget (`INJECT_BUDGET_KB`, 850 today) is lowered to 430 in the same change
that removes the libraries, so the size cannot come back unnoticed; its heap
ceiling (1,120 KB per frame) is lowered in that change too, to what the
suite then measures plus its usual margin.

**What the wasm side costs in exchange.**

- Bytes, once per controller: `rewriter.wasm` is 426,993 bytes (151,391
  brotli), fetched by the controller, cached by HTTP like any asset, and
  compiled once (21 ms, off the main thread). The service worker is handed
  the bytes (a 423 KB buffer per handshake) and compiles them once more.
  The suffix module below adds its own file. Against that, every proxied
  frame stops fetching, parsing and holding 399 KB of script.
- Memory, per rewriting thread: one instance in each rewrite worker, one in
  the service worker, one in each proxied top's library realm; none in a
  frame. An instance is 1.2 to 1.4 MB of linear memory until it meets a
  large script (the table above). The library realm it replaces is 223 KB
  of heap today, with meriyah's 272 KB unicode table where a rewrite built
  it (section 1), so a top pays more than it did (about 1 MB, most of it
  the reserved stack) and every frame under it pays less.

**The constraints, and how each is met.**

- _The library runs in a detached realm and only strings, numbers and
  booleans cross_ (AGENTS.md). Unchanged for every call a rewrite makes.
  The compiled module is the one exception, inward only (`adopt`): the
  library never reads it and never hands it back.
- _No instance per frame._ The instance lives in the top's library realm,
  where the JavaScript library lives today. A frame reaches it the way it
  reaches the library now: a synchronous call through its top's client
  (`sharedRewriter`), strings in and a string out. `wasm-share` asserts
  that a frame makes no library of its own and that what it evaluates is
  the module's rewrite.
- _The inject's rewrites are synchronous, and the module arrives by
  message._ So there are moments and realms with no module, and a JavaScript
  fallback has to exist for them. It leaves the bundle all the same: the
  library as it is today becomes an asset of its own (`rewriterLib.js`, a
  key in `Assets`), which the small library that stays in the bundle
  fetches with a synchronous request from the asset directory and evaluates
  in its own realm, with the globals it captured, the first time one of
  these happens:

  | Inject path                          | Served by                        | The fallback loads when                                               |
  | ------------------------------------ | -------------------------------- | --------------------------------------------------------------------- |
  | `modifyJS` (every path of phase 2)   | the rewriter module              | no module yet; the module declined the script or trapped              |
  | `singleExpression`, `parsesAsScript` | the rewriter module (parse only) | no module yet                                                         |
  | `printExpression`                    | the fallback, until phase 5      | something threw and its message names a part of the page's expression |
  | `modifyCSS`                          | the scanner module (phase 3)     | no module yet; the scanner declined the sheet                         |
  | `getDomain`, `getPublicSuffix`       | the suffix module                | no module yet, for a host other than the document's and its top's own |

  A document's own site and its top's are needed while the client is made,
  before any message can have arrived: the service worker, which keeps
  tldts (its bundle is one per scope, not per frame), writes them into the
  shell. A realm the module cannot reach at all (a sandboxed document with
  an opaque origin, a tab in another agent cluster) loads the fallback on
  its first rewrite, which is what it costs today. A page's dedicated
  worker is in its document's agent cluster and is handed the module with
  its transport port; a shared worker is not, and imports the worker
  flavour of the fallback with `importScripts`. A rewrite that can be made
  by neither (the fallback did not load) is refused, as a failed rewrite is
  today: the script does not run unrewritten.

- _The public suffix list._ A table of its own, not a crate's: the `psl`
  crate compiles the list into match code, which costs more than the data
  does, and `publicsuffix` parses the list's text at startup. `deploy/rust` fetches
  `public_suffix_list.dat` from the publicsuffix/list repository at a commit
  pinned with its checksum in `pins.env`, and builds a sorted table of the
  rules with their ICANN or private section and wildcard and exception
  marks, which a crate of a few hundred lines searches by label. It is an
  artifact of its own (`suffix.wasm`; an estimate from the list's ten
  thousand rules is 130 KB, 45 KB brotli, to be measured when it is built):
  `rewriter.wasm` has 10 KB of its brotli budget left, and the rewrite
  workers need no suffix list. The list stays current the
  way epoxy's pins do: the pin is raised by hand with the nightly, and a
  suite compares the module's answers with tldts's (which stays a
  dependency of the service worker) over a host corpus, so a tldts update
  that knows a suffix the table does not fails the suite until the pin is
  raised.

What is left of the library in the bundle after the removal: the codecs and
URL routing (the 18,632 bytes of crypto-js and STomp's own routing code),
the wasm glue, and the fallback's loader.

## 7. Staying compatible with a host's build pipeline

Fracital and abulxt rename STomp's files and substitute tokens in the built
artifacts, and abulxt ships wasm sealed and decrypts it in memory. The
artifact and its glue have to survive that. The checklist, each item with
the build step that enforces it:

| Requirement                                                                         | Enforced by                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| No name section, no producers section                                               | `wasm-opt --strip-producers --strip-debug`, then a check in `build.sh`     |
| No panic message, no source path, no crate name in the data segments                | `panic = "abort"`, `-Zlocation-detail=none -Zfmt-debug=none`, strip, check |
| No project token anywhere in the bytes                                              | a scan reading the `.wasm` as latin1 and failing on a token list           |
| Import and export names are short and neutral                                       | the hand written ABI (section 6), and the host may rename them             |
| Export names are substitutable at the same length                                   | single characters, so a same-length substitution is always possible        |
| The glue never reads `import.meta.url`                                              | it takes a URL, bytes or a `WebAssembly.Module` from the host              |
| Helper names come from the config at runtime, once per configure, never compiled in | the `configure` call, and a suite that rewrites under renamed helpers      |
| Every name the rewriter writes is configurable                                      | see below                                                                  |

Names that are fixed today and have to become configurable, because a host
that renames the rest would otherwise leave these as a signature: the hoisted
temporaries `t$t`, `t$p`, `t$v`; the derived `${access}a<i>` and
`${access}l<n>`; the holder statement's `function(){/*` wrapper shape; the
split placeholder `$stomp$part`; and `createClient`. Each gets a config field
with today's value as the default, so nothing changes for a host that sets
none. The `helper-names` and `helper-seal` suites gain cases for them.

## 8. The blocker

Built from `~/src/adblock-rust` (the `adblock` crate 0.13.5, upstream brave
at 09d297c, MPL-2.0, which is fine to ship alongside GPL-3.0 STomp).

Features: `default-features = false`, plus `full-regex-handling`,
`single-thread` and `css-validation` (required: without it procedural rules
land in `hide_selectors`). Dropped: `resource-assembler` (it wants a
filesystem), `content-blocking`, `debug-info`, and as built
`embedded-domain-resolver` too: the module asks the worker for a registrable
domain through its one import, answered by the tldts the worker already
carries, so the public suffix list is not in the artifact twice.

As built (phase 4): `docs/adblock.md` is the reference for what follows, and
says where the result differs from this plan (the option is `adblock`, the
suites are `adblock-engine` and `adblock`, and WebSockets are judged from the
controller's handshake hook, since they never pass the service worker).

Where each part runs:

- **Network blocking in the service worker, before the transport fetch.**
  The proxied URL is decoded to the real request URL and the real page URL
  first, then `Request::new(url, source_url, type, method)` with the type
  mapped from the service worker request's `destination` by hand: `style`,
  `iframe`, `audio`, `video`, `fetch` and the empty string all fall to
  `Other` otherwise, which changes what the lists match.
- **A blocked request answers as a natively blocked one does.** Chrome's
  `net::ERR_BLOCKED_BY_CLIENT` reaches a page as a network error, so the
  worker answers `Response.error()`: `fetch` rejects with a TypeError, an
  `<img>` fires `error`, a subresource simply fails. No STomp specific
  status, header or body, and no timing that differs from a transport
  failure. The `tells` suite gains blocker cases, and a blocked request must
  be indistinguishable from one a content blocker blocked natively.
- **`rewritten_url`** (the `removeparam` family) rewrites the request instead
  of blocking it; **`redirect`** is served by the worker from the resource
  set with the right MIME type; **`get_csp_directives`** is merged into the
  document and subdocument CSP the worker already builds.
- **Cosmetic filtering through the inject.** The worker calls
  `url_cosmetic_resources(url)` while it builds a document's shell and sends
  the result where the prewrite table already goes. The inject applies
  `hide_selectors` as a constructed stylesheet that the page's CSSOM cannot
  see (the existing style hooks), runs an in-page procedural filterer for
  `procedural_actions` (the crate only parses those to JSON; it does not
  apply them), and feeds newly seen classes and ids to
  `hidden_class_id_selectors` through the MutationObserver drain that already
  runs. That drain is on the keystroke path, so it is budgeted and batched,
  and the frame-cost suite gates it.
- **Scriptlets.** `injected_script` is one JavaScript string. It is rewritten
  by STomp's own rewriter and runs right after the inject and before any page
  script, so a scriptlet that wraps `fetch`, `XHR` or `location` sits on top
  of STomp's hooks and sees the page's own URLs. `trusted-*` scriptlets have
  no permission set in the resource file, so they get a permission mask
  granted only to lists the host marks as trusted.
- **Lists.** Fetched at runtime from URLs the host configures, or loaded as a
  prebuilt serialized engine. Nothing is vendored: the snapshots in the
  crate's `data/` are test fixtures, the licences (uBO GPL-3.0, EasyList
  GPL-3.0 and CC BY-SA) are compatible but fetching keeps them fresh and
  keeps the redistribution question out of the package. A serialized engine
  is the flatbuffers DAT format, version 8 with a seahash, and the crate
  skips verification when its own version matches, so only engines our own
  container built, pinned to the crate version, are ever loaded. Resources
  are not in the DAT: `use_resources` is called again from the resource JSON.
- **The option.** `adblock: false` by default. `true` or an object with list
  URLs, a prebuilt engine URL, a resource URL and the trusted list set. In
  the demo it is set the way every controller option is set there (the page
  has no option UI beyond the transport select): a URL parameter
  (`?adblock`, `?noadblock`) and a server variable (`STOMP_ADBLOCK`)
  rendered into `/config.js`, as `http3` and `serviceWorkers` are, plus a
  remembered toggle next to the transport select. Docs in `docs/` and
  suites (`adblock-network`, `adblock-cosmetic`, `adblock-tells`).

Known gaps to document rather than fix: the crate does not apply procedural
cosmetic filters (we interpret them), does not do HTML filtering (`##^`),
does not do response body `$replace`, and drops a whole rule when it carries
an option it does not recognise (`popup`, `header`, `denyallow`, `replace`).
On wasm it never discards a compiled regex (it has no clock), so engine
memory only grows in a long-lived worker: measured and bounded by rebuilding.

Native numbers to compare wasm against, from the brave main list (about
198,000 lines): build 82 ms, deserialize 1.1 ms, 9.7 MB of heap, about 5 us
per network check, about 40 us per `url_cosmetic_resources`.

## 9. Phases

Each phase ends with the gate (`npm run build`, `npx tsc --noEmit`,
`npm run lint`, `npx prettier --check .`, `npm run check:prose`), the full
suite set, a Chrome 156 run of the touched suites, benchmarks, and a commit
on the branch with a CHANGELOG bullet for anything a host can see.

**Phase 0 (this document).** The plan, the container build, the pinned
toolchain, and the differential harness skeleton. No behaviour change.

**Phase 1. JS rewriting in the rewrite workers and the service worker,**
behind `rewriter: 'wasm' | 'js'` with `'js'` the default. The wasm backend
answers for a script or declines it; declining falls back to the JavaScript
rewriter, so nothing can regress into a broken page. The split planner stays
in JavaScript this phase. Lands when the full set passes with the option
forced on as well as off.

As built: every family of the table in section 4 is in the visitor
(`rust/rwjs/src/walk.rs`), proved one family at a time against the
JavaScript rewriter by `rust/host/parity.mjs` (section 10; the numbers are
in section 11). `modifyJS` itself tries the module first when the config
says `'wasm'`, so the service worker, the rewrite workers and the page take
the same path and the same fallback. What the module declines, and so
leaves to the JavaScript rewriter: a script oxc does not parse (among the
cases only a top-level `new.target`, which meriyah lets through and which
is a function body's to use, so it cannot be handed back unrewritten), and
a destructuring key that is a BigInt beside an unforgeable (`{ 1n: z, top
}`). Two shapes it used to decline are scripts no browser runs, which it now
says (status 7) so that nothing else is asked: a V8 intrinsic
(`%DebugPrint(1)`: oxc is told to parse it so that it can be told apart) and
a parameter pattern in a function whose body says `"use strict"` (an early
error meriyah reports and oxc does not). A destructuring key that is a
number with a fraction or an exponent (`{ 1.5: z }`, `{ 1e21: z }`) is
spelled as JavaScript spells the number (`ToJsString` of oxc) and rewritten.
Measured declines after that: 0 of the 28 corpus scripts (46 MB), 0 of the
322 scripts of the suites' pages (`test/pages`, inline and files), 1 of the
680 cases. A script neither parser takes still goes through both (oxc's
refusal alone does not prove a browser refuses it): that, not a shape, is
what a fallback in the page will mostly be asked for. Two bugs of the module's own, found by the integrator's
fuzz, are fixed with these: the `;` that keeps a statement's opening
parenthesis from being the call of the statement before was written inside
an outer rewrite (`x\neval(a)[b]` came out as `$s$j.get2(;(...`, which
does not parse), and the text ahead of a script was written before a first
line that is an HTML close comment (`--> text`), which is a comment only
where its line starts. One divergence is known and kept, because the module is
right: `for (var location of top.a) ;` at the top level, where the
JavaScript rewriter replaces the loop twice and leaves `top.a` as written.
The parity runs found two bugs in the JavaScript rewriter, fixed with this
phase: a direct eval's arguments were not rewritten at all (`eval(top)`
handed the page the real top), and `super.postMessage(m)` came out
unparsable.

The option is one selector for every rewriter, not the JS rewriter's own:
`'wasm'` means each rewriter that has a wasm backend uses it (JS in this
phase, CSS and the markup scan when phase 3 lands), each from its own
artifact (`rewriter.wasm`, later `css.wasm`), each declining per input to
its JavaScript twin. The blocker is a separate option (`blocker`), since it
is a feature and not a backend. The config field reaches the service
worker, the rewrite workers and the inject together (section 10: three
places, one backend), and the rewrite cache keys on it.

**Phase 2. The inject's main-thread paths, and the libraries out of the
bundle.** The library realm instantiates the module and `modifyJS` there
answers from it: inline scripts in `loadHTML`, `eval`, `new Function`,
string timers, `document.write`, blob documents, `javascript:` URLs, worker
and srcdoc bootstraps. `printExpression` stays in JavaScript (it runs only
when something already threw). The split planner does not move to Rust
after all: under `'wasm'` nothing is split (section 5, item 7).

Built: a proxied top asks its controller for the compiled modules and its
library realm instantiates them (section 6), so every inject path of a top
and of the frames under it is the module's once the answer is in, with the
JavaScript library answering before that and for what the module declines.
Running the page's suites under it found one thing the contract of section
5 changes for the inject: a rewrite can now be its input byte for byte, and
the inject marked a script as rewritten by remembering the rewritten text.
An inline script with nothing to rewrite was then taken for one already
rewritten and ran unnamed (fixed: an unchanged rewrite leaves no mark). Any
other place that tells a rewritten text from a source by comparing them is
suspect under `'wasm'`.

Its definition of done, in the order the work goes:

1. the module answers `singleExpression` and `parsesAsScript` (a parse and
   the shape check, two flags), and the remaining declines of phase 1 are
   closed or shown to be scripts no browser runs (built: flags 64 and 128,
   status 7, "The ABI" above; what is still declined is listed above);
2. a page's dedicated workers are handed the module with their transport
   port, and the page's instance gets a memory threshold of its own;
3. the suffix module (`suffix.wasm`, its table built in `deploy/rust` from
   the pinned list), with the parity suite against tldts, and the service
   worker writing a document's own site and its top's into the shell;
4. the JavaScript library becomes the asset `rewriterLib.js` (and its
   worker flavour), loaded on first need as section 6 sets out, and
   meriyah, escodegen, css-tree and tldts leave `dist/injectDocument.js`:
   **at most 415,585 bytes** against 814,491 on master, with the
   `frame-cost` bundle budget lowered from 850 to 430 KB and its heap
   ceiling lowered to the new measurement in the same change;
5. the suites of section 10 under both backends, and `frame-cost`,
   `wasm-share` and the new suffix suite in the gate.

Step 4 needs the CSS scanner of phase 3 in the page (it adopts every module
the controller sends, so the scanner arrives with the rewriter) and a host
that serves one more asset; both `'js'` and `'wasm'` keep working, the
first by loading the fallback on its first rewrite.

**Phase 3. CSS and the markup scan, where they pay.** `rewriteCSS.ts`
already emits an edit list and parses lazily, so the Rust version is a
tokenizer level scan with the same output; the gate is byte-identical output
on the 142 sheet corpus. `prewrite.ts`'s regex scan of `<script>` and
`<style>` becomes a Rust scanner. The real HTML parse stays where it is, in
the page's own `DOMParser`: it is correct and free.

As landed (`rust/rwcss`, `scanner.wasm`, `src/wasm/scanner.ts`): the module
finds and JavaScript rewrites. Nearly all of `modifyCSS`'s time on a large
sheet is css-tree's lazy parse and the walk over it, which only find the raw
pieces worth looking into (a declaration's value, an at-rule's prelude, a
rule's prelude, text no parse shaped) by the test `MAY_ROUTE`. The crate is
css-tree 3.2.1's tokenizer, token stream and lazy node parsers ported
literally (its error recovery included: `parseWithFallback`, the balance
table, the at-rule block table), emitting no tree, only those pieces in
source order with UTF-16 offsets. Each piece then goes through the code the
walk called (`deep` and `route` in `src/rewriteCSS.ts`, css-tree's full
parse of that one piece included), so the output is the JavaScript
rewriter's by construction and not by a second implementation of the
rewrite. The module's filter is narrower than `MAY_ROUTE` (`url(`,
`image-set` and `src(`, which is every case that can produce an edit, plus
an `@import` prelude), so a piece that could only ever come back unchanged
is not handed over at all. The markup half is a literal port of
`src/prewrite.ts`'s three expressions (`<script>`, `<style>`, `<base
href>`), one pass in place of three, with JavaScript's `\s` and ASCII-only
case folding.

The scanner declines (status 5, and css-tree parses the sheet as before)
only what is past the port: a sheet of more than 0xFFFFFF UTF-16 units
(css-tree's 24-bit token offsets wrap), blocks nested more than 64 deep
(the port recurses), and a parse that stops advancing. None of the corpus
does, and 24 of 400,000 fuzzed sheets do.

It first declined a closing bracket with nothing open as well, because
css-tree's own answer for one depended on the sheet it had parsed before:
it reads the token at index `source.length` of a buffer it keeps between
parses and never writes there. That was a bug of the JavaScript path, not a
limit of the port (the same sheet parsed differently from load to load,
and the fuzz found a pair of sheets whose second never stopped parsing), so
`src/rewriteCSS.ts` now clears the buffer after every parse
(`css-parse-history` suite) and the scanner answers such a sheet as
css-tree does with a clean one.

The corpus on disk is 99 sheets (11.9 MB: `csscorpus`, YouTube's, CNN's),
not the 142 this plan named: all rewrite byte for byte the same with the
scanner and without (48 are scanned, the other 51 hold nothing to route),
in 364 ms against 953 ms. A wider sweep of 2,297 stylesheets from this
machine's caches and packages (57.8 MB) is identical too, 3.3 s against
78 s. The `scanner-parity` suite holds the hand-written cases, every
stylesheet and document under `test/pages`, and a seeded fuzz that mutates
them (`SCANNER_FUZZ` rounds, `SCANNER_CORPUS` for a corpus directory); it
needs no browser. The service worker is the scanner's only caller: the
`/css/` route (the request log says `rewriteBy: 'wasm'` or `'js'`), and a
prewritten document's markup and inline styles. The inject's CSS paths stay
on css-tree until phase 2 gives the library realm its modules.

**Phase 4. The blocker.** The second artifact, the service worker's network
path, the cosmetic and scriptlet paths, redirect resources, the option, the
demo toggle, docs and suites.

**Phase 5.** `rewriter: 'wasm'` becomes the default once the parity suites
have been green across a few nightlies, and the JavaScript library is then
only the fallback asset of phase 2: no bundle carries meriyah, escodegen,
css-tree or tldts, and the budgets phase 2 lowered stay where it put them
(`injectDocument.js` at most 430 KB in `frame-cost`, measured at 415,585
bytes or less). Optional: `callPrinter.ts` in Rust, which would stop an
error message from being the one thing that loads the fallback. Probably
not worth it for the printer alone: it only runs on error paths.

## 10. Test strategy

- **Both backends, every phase.** The full set runs as CI runs it, and again
  with the rewriter option forced to `wasm`. The runner keys results by
  suite file and has no way to run one suite twice, so the second run is a
  second `npm test` with `STOMP_REWRITER=wasm` in the environment: the runner
  already passes its environment to each suite's demo server, the demo reads
  it into `pageConfig`, and the suites that build their own controllers
  (prewrite, split-rewrite, rewrite-pool, membrane-flag and others) read the
  same variable. The key suites are
  `rewriter-unit`, `rewriter`, `function-source`, `function-strings`,
  `error-messages`, `tells`, `native-shapes`, `helper-seal`, `helper-names`,
  `helper-realms`, every `adversarial-*`, `escapes-*`, `prewrite`,
  `split-rewrite`, `rewrite-pool`, `rewrite-cache*`, `css*`, `literals`,
  `optional-chains`, `strict-mode`, `frame-cost` and the `sop-*` and
  `mixed-content` suites.
- **`rewriter-unit`'s exact-output expectations.** 21 of its 44 checks are
  regexes or literals over escodegen's spelling (single quotes, `, `
  spacing, parenthesised partials, 24 hand-written whole outputs) and cannot
  hold for spliced output. The suite imports `modifyJS` directly, so it has
  a backend switch of its own (`STOMP_REWRITER=wasm` adopts
  `assets/rewriter.wasm` into its thread). As built, a spelling check under
  wasm compares programs: the module's output is parsed and printed the way
  the JavaScript rewriter prints, and the same expectation is applied, so
  one expectation states both contracts; the few whose point is the
  spelling itself (a BigInt's digits, a `sourceURL` comment) have an
  expectation per backend. The module's exact bytes are pinned where they
  belong: in the crate's own tests and in `wasm-artifact`. Its `unmarked`
  helper strips the holder and the marks, which the wasm backend emits byte
  for byte as `src/functionSource.ts` spells them.
- **Three places, one backend.** `rewrite-pool` asserts the pool's output
  is byte for byte the service worker's, and `prewrite` compares a worker's
  rewrite with the page's. So the option selects the backend for the service
  worker, the rewrite workers and the inject together, never one of them.
- **`error-messages` pins four cases as different from native** (tagged
  templates and `o?.u[k]`, its `RECORDED` list). A backend that gets them
  right fails the suite until they are removed from that list, which is the
  intended way to record the improvement.
- **A new Config field crosses two whitelists.** `src/server/rewrites.ts`
  (the worker's) and `src/inject/Client.ts` (the inject's) each name the
  fields they pass on; `membrane` is the model to copy, through
  `src/config.ts`, `src/controller/index.ts`, `remote.ts` and `frame.ts`.
- **New suites.** `wasm-rewriter` (a controller with `rewriter: 'wasm'`:
  the pool and the service worker rewrite with the module, byte for byte
  alike, untouched text is kept, a function reads back as written, a
  declined script is the JavaScript rewriter's, and a `'js'` controller
  uses none of it), `scanner-parity` (phase 3: `modifyCSS` and the prewrite
  scan with the scanner module and without, byte for byte), `wasm-share`
  (every thread that rewrites holds the
  modules the controller loaded once, a top's library holds the module and
  a frame under it makes no library of its own), `wasm-artifact` (no name
  or producers section, no project token in the bytes, every export
  renamable, the flags and statuses of the ABI), and in phase 4 the three
  blocker suites. The corpora are not a suite: they live in `/tmp` and
  take minutes, so `rust/host/parity.mjs` runs them by hand each phase.
- **Differential harness.** `rust/host/parity.mjs` runs the artifact and
  `modifyJS` over the same scripts in Node, so a disagreement is found
  without a browser (no native binary: the artifact under test is the one
  that ships). The two do not print alike, so each output is parsed again
  and the programs are compared as trees, the function marks as lists and
  the holder as text. `--cases` runs `rust/host/cases.mjs` (every family by
  shape, 669 scripts), a directory is a corpus. A script the module
  declines is counted apart with its reason, and one the module rewrites
  but meriyah refuses is a failure, which is the parse parity sweep.
  `--cases` also holds the module's revision to its outputs
  (`cases.revision`).
- **Property tests** on the splice engine (nested, adjacent and
  point-coincident edits) and on the mark placement.
- **The coverage macro** fails the build when a visitor method can exit
  without walking a field that can reach an expression, and prints a JS
  snippet that would exhibit the miss.

Reruns: the machine is shared at load 20 to 60, so a failure is rerun alone
with `PARALLEL=1` before it is believed.

## 11. Benchmarks

Corpora already on disk: `/tmp/stomp-speed/js` (46 MB of CNN, Discord and
Docs scripts with an `index.json` each), `/tmp/stomp-load-a4e6` (`csscorpus`,
`yt`), `/tmp/stomp-rw-ac1a`. Nothing in the repository times the rewriter;
the per-phase bench in `/tmp/stomp-speed/alloc-bench/rewrite-bench.ts`
(parse, print, whole) is the starting point and moves into `rust/host`'s
Node side so it survives `/tmp`. Real sites are alternated between two
servers, medians of at least five runs each, because the machine is shared
and YouTube serves different bundle sets per run.

Reported every phase:

| Measurement                   | Today                            |
| ----------------------------- | -------------------------------- |
| YouTube home, warm and cold   | 1.7 s / 3.9 s (native 0.7 / 1.2) |
| Google's worst keystroke      | about 0.55 s at 4x throttling    |
| CNN first visit               | fcp 3.9 s (was 6.0)              |
| Discord `web.js`              | 1.5 s split, 3.5 s unsplit       |
| Docs Closure bundles          | plain rewrite time of 3 to 7 MB  |
| Rewrite only, per corpus file | the harness number               |
| Artifact size, raw and brotli | budget 600 KB / 160 KB           |
| Per-frame heap and RSS        | ceiling 1,120 KB                 |

Phase 1, measured (2026-11-10, Node 24, load about 20; medians of three):

| Measurement                                      | JavaScript | wasm                                                                     |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------ |
| the 46 MB corpus (28 scripts), rewrite only      | 13.6 s     | 2.0 s (6.7x)                                                             |
| Discord's 12 MB `web.js`, whole, one thread      | 3.1 s      | 0.43 s                                                                   |
| parity, the corpus                               |            | 28 of 28 the same                                                        |
| parity, 1,309 files of `node_modules` over 2 KB  |            | 1,309 the same                                                           |
| parity, the 680 cases                            |            | 675 the same, 0 differ, 1 known divergence, 1 declined, 3 neither parses |
| artifact                                         |            | 426,993 bytes, 151,391 brotli                                            |
| `dist/injectDocument.js`, master and this branch | 814,491    | 816,570                                                                  |

## 12. Risks

| Risk                                                                                             | Handling                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| oxc and meriyah disagree on what parses (webcompat, global return, V8 intrinsics, HTML comments) | the parse parity sweep over the corpora; a disagreement falls back per script                               |
| the optional chain rewrites are the hardest to express as edits                                  | their own differential corpus, the coverage macro, and a per-script fallback until proved                   |
| nested or overlapping edits                                                                      | the nest-aware engine, property tests, and a failed rewrite falls back rather than emitting garbage         |
| wasm instance memory never shrinks                                                               | allocator reset, instance replacement past a threshold, idle drop in the service worker                     |
| a per-frame wasm instance would blow the frame-cost ceiling                                      | the instance lives only in the shared library realm; `wasm-share` asserts it                                |
| the fallback library is fetched synchronously where a rewrite cannot wait                        | it loads at most once per top, only on the paths section 6 lists, and a rewrite that has neither is refused |
| the suffix table goes stale against tldts                                                        | the pin is raised with the nightly, and a suite compares the two over a host corpus                         |
| the artifact carries a token or a name section that a host's canary scan would reject            | the build fails on it, so it cannot ship                                                                    |
| no Rust toolchain on this machine (no rustup, cargo, wasm-opt or wasm-bindgen)                   | everything is built in the container, as epoxy is                                                           |
| blocker list fetches fail, or a list licence is awkward to redistribute                          | lists are fetched at runtime, nothing is vendored, and a failed fetch leaves the blocker off                |
| the blocker adds a tell                                                                          | a blocked request is a plain network error; the `tells` suite gains cases                                   |
| other agents land in `src/inject` and `src/server` continuously                                  | rebase onto `origin/master` before every phase and before every gate run                                    |

## 13. Toolchain, as found today

- No `rustup`, `cargo`, `rustc`, `wasm-opt`, `wasm-bindgen` or `wasm-snip`
  on this machine. `brotli` and `docker` 29.5.2 are there, with the epoxy
  build images already cached. 32 cores, load around 11.
- So the build is containerized from the start, like `deploy/epoxy/`: a
  pinned base image, a pinned nightly, a pinned binaryen, every revision in
  `pins.env`, `--locked` builds, a committed `Cargo.lock`, and a source hash
  written into `UPSTREAM` beside the artifact. Two things the epoxy build
  does not do and this one does: the base image is pinned by digest and the
  nightly by date (epoxy's `rustlang/rust:nightly-bookworm` floats, so its
  Rust version is whatever the tag points to on build day), and every
  downloaded tool (binaryen, and wasm-snip if it is used) is checked against
  a recorded checksum (epoxy's are not).
- Where docker's bridge cannot reach the crate and npm mirrors, the build
  takes `ENGINE` pointing at a wrapper that adds `--network host` to
  `docker build`, exactly as the epoxy build does. Nothing is ever piped
  from `curl` into a shell; every download is pinned and checksummed.
