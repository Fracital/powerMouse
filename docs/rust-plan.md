# The Rust rewriter and the built-in blocker

The plan for moving the slow half of STomp (the JS rewriter first, then the
CSS rewriter and the markup scanner) from meriyah and escodegen to Rust compiled to
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
├── rwcss/              the CSS rewriter and the markup scanner, one module
│                       (phase 3): css.rs (css-tree's tokenizer and lazy
│                       parse), full.rs (its value, selector and prelude
│                       parsers), rewrite.rs (the routing and the splice),
│                       markup.rs, abi.rs
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

Early errors. oxc's parser reports none of them (its crate leaves them to
a semantic pass), so a script V8 answers with a SyntaxError was rewritten:
the page read the error at another line and column, and where the rewrite
replaced the construct the script ran (`delete location` in strict code
became a call of the access API). `oxc_semantic` was measured and not
taken: 115 KB more of artifact (39 KB brotli, past the budget), 44% more
rewrite time, and it refuses eight Annex B scripts a browser takes. The
module has its own check instead (`rust/rwjs/src/early.rs`, by the clauses
of ECMA-262 as V8 reads them), driven by the rewrite's own walk: the walk
calls its hooks where it meets a node, so the tree is walked once for both.
A regular expression's pattern is asked of the same walk
(`rust/rwjs/src/pattern.rs`): a pattern of the plainest kind (99% of the
corpus's) is answered by a scan of its text, any other by the parser. A
walk that declines a script may have left a part unwalked, so the check
then walks the tree on its own, as it does for the two parse questions;
the crate's tests hold the two walks to one verdict on every recorded text
in eight places, and the scan to the parser's answer on a fuzz of patterns.
A script the check refuses is
answered as one no browser runs (status 7) and goes out as it came, so the
browser reports its own error at the page's own position; syntax no
browser has yet (decorators, `accessor` fields, `import.defer()`) is
declined to the JavaScript rewriter rather than called an error, so the
day a browser takes it nothing goes out unrewritten. The two parse
questions ask the check too. `delete` of a bare name keeps the name in
both rewriters: eval code is strict by its caller, which no rewrite sees,
and V8 has to refuse `delete top` there. The check errs to one side only:
what it reports V8 refuses. `eval` or `arguments` written with an escape
(`\u0065val`) where strict code refuses the name is the sharpest case:
Chrome 138 (V8 13.8) and later refuse it everywhere, as they refuse
`eval`, but V8 13.7 and before (Chrome 137, node 24) take it in a function
they compile lazily, whose preparser reads the name as written, so a
script answered as one no browser runs would run unrewritten there. The
check refuses the escaped name only outside every function, where V8
always parses in full, and the rewrite writes it as the page did. It is
held to Chrome's verdicts on
`rust/host/early-errors.txt` (5,348 texts written from the early-error
clauses and Annex B, the last 930 generated from the strict-mode errors in
each place that makes code strict (`strictTexts` in
`rust/host/early-lib.mjs`), each recorded as a classic script, a strict
one and a module, and run by `rust/host/early.mjs` in 14 more places:
90,902 scripts) three ways: the crate's tests against the record,
`rewriter-unit` against node's V8 (13.6, so the escaped names are held to
the older preparser too: nothing it takes is answered as one no browser
runs), and the `early-errors` suite against Chrome, natively and through
the proxy (`new Function`, eval, inline and fetched scripts, `import()`,
workers). Of the 55,890 scripts node's V8 refuses none runs rewritten;
26,418 the module answers itself, 28,995 its parser refuses (the
JavaScript rewriter's, which hands nearly all back as they were) and 477
it rewrites into what V8 refuses (`super`, a private name or `using` at
the top level, and a top-level `return`: a handler's body and a direct
eval's code reach it as classic scripts, where those may stand; and an
escaped `eval` in a function V8 parses in full, three of them with
another message). Of the 35,012 it takes none goes out unrewritten or
broken; 560 are declined (34 texts its parser refuses, one shape).
`rust/host/early-known.txt` names each of these, and a name nothing needs
any more fails the run. The other direction, over real scripts
(`early.mjs --corpus`): of the 28 corpus scripts, the 341 of the suites'
pages and 2,346 files of `node_modules` (66 MB) nothing V8 takes is
answered as an error. The JavaScript rewriter on the same table: 182 of
the refused scripts run rewritten (38 texts: the 12 it always took, two
module forms the harness used to stop short of, and escaped `eval`s V8
13.6 parses in full in parentheses, which the printer drops; Chrome 138
refuses those either way), every script V8 takes is rewritten, and 29
come out broken (three texts); the wasm backend inherits the first kind
for what its own parser refuses. Its parser is meriyah 7.4.1 patched
(`vendor/meriyah`, the patch and why in `meriyah.patch`) to take what V8
takes and meriyah refused: a reserved word of strict code as a name in a
generator (which meriyah read as strict code), a call assigned to in
strict code, a string on its own line that the next line carries on (no
directive), strictness that outlasted a strict function or a class,
escaped `eval`, `arguments`, `await` and `yield` where they are names,
and six rarer shapes; on 2,493 real files the trees are the unpatched
parser's. A script the JavaScript rewriter still cannot rewrite (its
rewrite throws) is not handed back unrewritten where the browser would
run it: the browser's own engine is asked, compiling and never calling it
as a function's body (a strict async function's for a module without
`import` or `export`), and one it refuses goes as it came, one it may take
goes with an end no browser compiles
(`this.#STomp_could_not_rewrite_this_script`), refused before any of it
runs. Over the early-error texts none is, nor over 2,492 real scripts. Cost, as first landed (a walk of its own after the parse, and the
parser parsing every pattern): 15,631 bytes of artifact (5,243 brotli) and
12% of rewrite time on the corpus (2,341 to 2,613 ms for the module alone,
medians of five, interleaved, load 18), +7.3% of the module's
instructions. Driven by the rewrite's walk, with patterns scanned: +3.8% of
instructions with V8's default tiering and +0.2% in optimized code alone
(`perf stat` over 59 `node_modules` scripts, 37 MB, three passes net of
one; the rest is the check's own work, most of it the declarations' table,
which V8 does not inline in the walk), at 14,574 more bytes of artifact
(4,316 brotli). The output and every verdict are byte for byte the
same. Refusing the escaped names only outside a function, and writing
them as the page did: 626 bytes (338 brotli).
The toolchain is pinned by the image digest rather than a
`rust-toolchain.toml`: the pins in one file, and no toolchain download at
build time.

Two artifacts, built separately so a deployment that wants none pays for
none:

- the core module (`core.wasm`, `rust/core-module`): the JS rewriter
  (`rwjs`), the scanner (`rwcss`, phase 3: the CSS rewriter and the markup
  scan) and the suffix lookup (`suffix`) built in as libraries, with one
  export table (each member's exports under a letter of its own, `j`, `s`
  and `d`), one memory and one allocator. 588,207 bytes, 215,404 brotli,
  where the three were 475,918 + 48,518 + 81,416 = 605,852 bytes, 224,053
  brotli: 17,645 bytes less (8,649 brotli), the standard library's
  allocator and buffer code being there once (the budget is 640 KB, 230 KB
  brotli). A fresh instance is 1,280 KB of linear memory, where the three
  were 1,152 + 1,088 + 192 KB. "The core module" below has what it costs
  and saves per thread.
- the blocker module, 1,063 KB, 299 KB brotli (the crate's regex and idna
  tables dominate). Only the service worker runs it, and with
  `adblock: false` none of it is fetched, so it stays a file of its own.

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
  with no shareable top (a sandboxed frame without `allow-same-origin`)
  holds no module and rewrites with the rewriter library, whose text its top
  hands it ("The inject bundle without the JavaScript libraries", below).
- a page's dedicated worker keeps one instance in its own copy of the light
  library, made from the compiled module the context that started it hands
  it ("A page's workers", below). A shared worker is another agent cluster
  and loads the rewriter library the first time it rewrites.

How the page's realm gets the module, given how that realm is made: the top
evaluates the library's own source text in an about:blank frame and removes
the frame in the same task, so the library can name nothing of the outer
bundle and its DOM globals are captured while it is still attached
(`src/libGlobals.ts`). Two consequences:

- the module's bytes are never inlined into the library text. The text is
  embedded in `injectDocument.js` and counts against its budget, and 600 KB
  of base64 would blow it. The module is handed in.
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

### A page's workers

A dedicated worker is in the agent cluster of the context that starts it, so
the compiled module is posted to it as it is. The worker's first message,
the one that carries its transport port (`TRANSPORT_INIT`), carries the
modules its creating context holds (`WORKER_MODULES`,
`Client.provisionWorkerTransport`), and the worker's own copy of the
rewriter library adopts them when it is first needed
(`handModules` in `src/inject/rewriter.ts`): a worker that evaluates no text
makes no library and no instance. A frame holds no module, so its workers
are handed its top's. A worker hands what it was handed to the workers it
starts. A page's emulated service worker is a dedicated worker of the
controller's and is handed the controller's the same way. Only the
browser's own first message is taken, read with getters taken before the
worker's script ran: a worker that dispatches a message of that shape at
itself, or replaces what a message's data is read with, would otherwise
choose the rewriter of everything it evaluates (`worker-rewrites` suite).

Measured in Chrome 152 and 156 (16 workers, the module posted compiled
against its bytes posted and compiled in the worker; medians, the two
Chromes within 0.2 ms of each other):

| Per worker                    | Handed compiled | Handed the bytes       |
| ----------------------------- | --------------- | ---------------------- |
| posting                       | 0.0 ms          | 0.2 ms (a 427 KB copy) |
| compiling                     | none            | 0.4 to 0.5 ms          |
| instantiating                 | 0.1 to 0.3 ms   | 0.1 ms                 |
| first rewrite of a few lines  | 0.2 ms          | 0.2 ms                 |
| private memory, once it wrote | 230 to 280 KB   | 1,150 to 1,360 KB      |

It arrives without a recompile, and with what other threads compiled: V8
compiles a function of the module when it is first called, and that code
belongs to the module, not to the thread. The first rewrite in the first
worker takes 2.9 ms when no thread has run the module and 0.2 ms when the
creating document has, and a 280 KB script 17.5 ms against 8.4 ms (7 ms in
every worker after).

In the product (a proxied page, 12 workers started once the page holds the
module, each making a function from text): the first rewrite takes 6.3 ms
in a worker that holds the module (nearly all of it evaluating the library,
which carried the JavaScript rewriter when this was measured, before it
became the asset `rewriterLib`) and 0.2 ms after, against 10.1 ms and 0.6 ms with the JavaScript rewriter; a
280 KB function 13.6 ms against 112 ms; and a worker that has rewritten
holds 225 KB more than an idle one against 731 KB.

Why with the first message and not asked for over the worker's transport
port: the order of what a classic worker runs was measured (9 of 9 runs in
both Chromes):

| Order | With the first message          | Asked for over a port           |
| ----- | ------------------------------- | ------------------------------- |
| 1     | the worker's script, to its end | the worker's script, to its end |
| 2     | its microtasks                  | its microtasks                  |
| 3     | a 0 ms timer it set             | a 0 ms timer it set             |
| 4     | a fetch it started (local)      | a fetch it started (local)      |
| 5     | **the module**                  | the page's first message        |
| 6     | the page's first message        | **the module** (0.2 ms later)   |

Chrome keeps what is posted to a worker in the thread that started it until
the worker's script has run to its end, and relays it then. So nothing
posted reaches a classic worker's top level, or the timers and fetches of
it that beat the relay: what those evaluate is rewritten by the JavaScript
rewriter whichever way the module travels, and asking adds the page's first
message to them. A module worker is better off: its preamble awaits the
inject bundle, the first message arrives during that await, and the modules
it brought are adopted before the page's module runs, so a module worker
rewrites with the module from its first statement.

What stays with the JavaScript rewriter, then (the asset `rewriterLib.js`,
which a worker loads with a synchronous request the first time it needs
it):

- a classic worker's own top level, as above;
- a worker started before its creating context holds the module, until
  the module has followed. The first message then carries a port in place
  of the modules, and they come on it when the context has them; the
  page's first message is handled before that. A page asks for its module
  when its client is made and the answer takes three hops, so a worker
  that a page's first script starts is in this case (in the fixture, its
  first message is the JavaScript rewriter's and what it evaluates 50 ms
  later the module's);
- shared workers, and a worker of a sandboxed document with an opaque
  origin.

Both windows close only with the module held synchronously: by the page
when its client is made (read from the controller's window, which is of its
origin, in place of the message), and for a classic worker's top level by
fetching and compiling the bytes in the worker (0.5 ms and 1.2 MB a
worker, above). Neither is built.

### Config and cache

The rewrite workers hold no config between requests today (every
`RewriteRequest` carries the whole config). The worker keeps the last
config's JSON, as `src/rewriterLib.ts`'s `enter` does, and calls `configure`
only when it changes, so the once-per-change rule holds without a new
message. The rewrite cache keys on the config, so the backend choice becomes
part of the key on its own, as it must: the two backends' outputs differ.

Per-frame cost therefore goes down, not up, once the JavaScript libraries
leave the inject bundle: that is a goal of phase 2 with a number on it, set
out under "The inject bundle without the JavaScript libraries" below. The
`frame-cost` ceiling (1,150 KB of heap per frame, `injectDocument.js` at
most 460 KB since the JavaScript libraries and the document's light library
left it, 850 before) is a gate
on every phase.

### Instance memory

wasm linear memory never shrinks. A 13 MB script will grow an instance to
tens of megabytes and keep it. Three mitigations:

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
has touched are not committed by the system. Over the 28 corpus scripts
(214 KB to 12 MB) a new instance ends the rewrite holding 9.7 to 33.9 times
the script's length in UTF-16 units, 23.9 at the median: 3.7 to 11.8 MB for
the eleven scripts of 214 to 355 KB, 8.6 to 41.1 MB for the eleven of 0.5
to 1.4 MB, 31.9 to 86.8 MB for the four of 3.1 to 3.5 MB. Compiling the
module takes 21 ms off the main thread.

**The second mitigation is built** (`src/wasm/thread.ts`), for every thread
that holds an instance. A thread keeps the instance a call used for the next
call, unless it ended the call holding more than the thread's limit: then
the next call gets a new one from the same compiled module. The check is
made when the call has returned and nowhere else, so an instance is never
replaced under a rewrite, and one that grows past the limit during a call
finishes it.

What replacing an instance costs (Node 24; Chrome 152 and 156 agree where
they were measured):

| What                                                             | Cost            |
| ---------------------------------------------------------------- | --------------- |
| a new instance from the compiled module                          | 0.14 ms         |
| the same in Chrome, in a page and in a worker                    | 0.1 to 0.6 ms   |
| its first small rewrite (the configuration is handed over again) | 0.14 ms         |
| a small rewrite on a kept instance                               | 0.02 ms         |
| growing again, per MB the next script needs (page faults)        | 0.19 to 1.16 ms |
| the 28 corpus scripts, each on an instance already grown         | 1,783 ms        |
| the same, each on a new instance                                 | 2,451 ms (+37%) |

The last three rows are the CPU time of the process, the least of seven
runs per script. Growing again is what a limit costs: 0.7 to 4.2 ms for a
script of 214 to 355 KB (on 6 to 17 ms), 3.7 to 10.7 ms for one of 0.5 to
1.4 MB (on 16 to 67 ms), 19 to 82 ms for one of 3.1 to 3.5 MB (on 78 to
155 ms), 231 ms for Discord's 12 MB bundle (on 444 ms).

What a limit does to a site's load: each site's large scripts through one
thread in the order the site serves them, twice (a load and a reload),
growth priced at the corpus average of 0.71 ms per MB:

| Limit  | CNN (12 scripts)                | Discord (7)                      | Docs (9)                        |
| ------ | ------------------------------- | -------------------------------- | ------------------------------- |
| none   | no drop, +38 ms (4%), 54.8 MB   | no drop, +141 ms (12%), 199.5 MB | no drop, +124 ms (8%), 174.9 MB |
| 128 MB | no drop, +38 ms (4%), 54.8 MB   | 2 drops, +294 ms (25%), 16.4 MB  | 2 drops, +264 ms (18%), 23.2 MB |
| 64 MB  | no drop, +38 ms (4%), 54.8 MB   | 2 drops, +294 ms (25%), 16.4 MB  | 6 drops, +505 ms (34%), 23.2 MB |
| 32 MB  | 2 drops, +99 ms (11%), 31.9 MB  | 2 drops, +294 ms (25%), 16.4 MB  | 8 drops, +562 ms (38%), 23.2 MB |
| 16 MB  | 8 drops, +189 ms (21%), 1.1 MB  | 8 drops, +373 ms (32%), 1.1 MB   | 10 drops, +578 ms (39%), 1.1 MB |
| 8 MB   | 14 drops, +235 ms (26%), 1.1 MB | 10 drops, +387 ms (33%), 1.1 MB  | 12 drops, +593 ms (40%), 1.1 MB |
| 4 MB   | 24 drops, +271 ms (30%), 1.1 MB | 14 drops, +405 ms (35%), 1.1 MB  | 16 drops, +611 ms (41%), 1.1 MB |

(drops, the time growing cost and its share of the rewrite time, and what
the thread holds when the load is over.)

Two limits follow from who holds the instance:

- **64 MB for the service worker and the rewrite workers**
  (`SERVING_MEMORY_LIMIT`). They rewrite a site's scripts, one large one
  after another: at most four rewrite workers for a controller, and one
  service worker. Every corpus script up to 1.4 MB fits (41.1 MB at most),
  so CNN's load never drops an instance; the scripts that do not fit are
  Discord's 12 MB bundle (199.5 MB, held for the one rewrite and then not
  at all) and three of Docs' (84.9, 86.8 and 174.9 MB). A higher limit buys
  little (128 MB saves Docs 241 ms over two loads) for twice what five idle
  threads may hold; a lower one makes every script past it pay the growth
  again, 21% of CNN's rewrite time at 16 MB.
- **8 MB for a page's library and for a dedicated worker**
  (`PAGE_MEMORY_LIMIT`, what a thread has unless it says otherwise). They
  rewrite what the page evaluates, mostly a few lines at a time (1,344 KB,
  of which a worker commits 230 to 280 KB), and there is one for every tab
  and one more for every worker of every tab, for as long as the tab lives.
  8 MB is what a script of 250 to 300 KB leaves behind (4.9 to 7.6 MB for
  the corpus scripts of 214 to 327 KB), so everything up to that size keeps
  its instance; a page that evaluates a 1.2 MB string pays 9 ms more each
  time (76 ms against 67) and holds nothing for it afterwards.

Chrome gives the memory of a dropped instance back when the thread's heap
is next collected (private memory of the renderer, a 3.5 MB script, an
instance of 88,960 KB; Chrome 152 and 156 alike):

| State of the renderer                                   | Over its start         |
| ------------------------------------------------------- | ---------------------- |
| the instance kept                                       | +76 to +86 MB          |
| dropped, after a `gc()`                                 | +2 to +5 MB            |
| dropped, the thread idle and no `gc()`: 1 to 20 s later | +82 to +85 MB          |
| the same, 30 s later                                    | less than at the start |

Nothing frees it sooner: the buffer of a `WebAssembly.Memory` cannot be
detached, and a page has no call that collects. An idle thread, a page's
or a worker's, gave the memory back between 20 and 30 s after the drop in
every run. A thread that goes on rewriting collects it with its next
large allocation: over four rounds of a small script, the 3.5 MB one and a
drop, the renderer never held more than the live instance and one dropped
one (+98 MB at most).

**A rewrite made during a rewrite** runs in an instance of its own. A
`data:` module a module imports is rewritten from inside the routing call of
the module around it, on the same thread and the same stack, and a `data:`
stylesheet a stylesheet imports is the same shape (`routeCSS` rewrites it
while the scanner module waits for the route of the `@import`); the instance
in the call cannot be entered again while its output is half written, and
until this was built the inner piece was the JavaScript rewriter's, which in
a thread whose bundle carries no JavaScript rewriter means loading the
fallback asset. A call takes an instance that is in no call, or makes one,
and puts it back when it returns: each call has its own instance and its own
route, the outer route goes on answering the outer call, a trap costs the
call that trapped its instance and nothing else, and the limit is applied to
each instance as its own call returns. A thread runs at most four instances
of a module at a time (`INSTANCES`); a piece nested deeper than that is the
JavaScript rewriter's, as it was. One inside another is what pages write.

The `wasm-instances` suite holds this in node: the same eight scripts
rewritten with the limit out of reach (one instance, none made), forced to
2 MB (every large script costs its instance) and forced to 0 (every call a
new instance) come out byte for byte the same; an instance past the limit
finishes its call and is replaced after it; a call made from inside a
routing call is answered by a second instance and both are kept; a `data:`
stylesheet inside a stylesheet is the scanner module's rewrite, by a second
instance, and css-tree's byte for byte; and the rewriter's glue rewrites a
`data:` module inside a module with the module. Nested five deep, the
innermost of either is JavaScript's and the text is the same.
`worker-rewrites` has both in the browser: a function of 410 KB that a
worker and a page evaluate (16.9 MB, past their limit) and what they
evaluate after it are the module's rewrite and read as they do natively, and
so does a `data:` module a module worker imports statically, which is
rewritten where the worker's script is served.

The idle drop in the service worker is not built.

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
budget (`INJECT_BUDGET_KB`, 850 before the split, 630 with meriyah and
escodegen out) is lowered to 430 in the same change that removes the last
of the libraries, so the size cannot come back unnoticed. Reached, by the
budget and not by the byte count: the bundle is 428,139 bytes (418 KB).
The 415,585 was taken on master, and by the time of the removal the bundle
with the libraries in it had grown to 860,006 (the wasm glue, the shell's
site facts, the blocker's page side); the stub build's saving of 398,906
would have left 461,100, and the removal saves 431,867. Its heap ceiling
(1,120 KB per frame) moves only by what is measured, and nothing was: a
frame never evaluated the library ("As built" below).

**The core module.** The rewriter, the scanner and the suffix lookup were
three artifacts (`rewriter.wasm`, `scanner.wasm`, `suffix.wasm`) until they
were built into one (`rust/core-module`). Each thread keeps instances of it
(src/wasm/thread.ts): a call of any member takes one that is in no call,
so a page's library realm that rewrites scripts and styles holds one
instance where it held two, and a call made during a call (a `data:`
module a module imports, a `data:` stylesheet a stylesheet imports, or a
member asked from inside another's routing call) still runs in an
instance of its own, which a throw costs alone. Measured on the demo with
a fixture page (external, module and inline scripts, stylesheets, two
dedicated workers that evaluate text), Chrome 152, cold:

|                                               | three modules      | the core          |
| --------------------------------------------- | ------------------ | ----------------- |
| controller: fetched                           | 3 files, 605,852 B | 1 file, 588,207 B |
| controller: compiles                          | 3                  | 1                 |
| service worker: compiles (with the blocker's) | 4                  | 2                 |
| page library realm: instances, linear memory  | 2, 2,621,440 B     | 1, 1,507,328 B    |
| page dedicated worker that evaluates text     | 1, 1,376,256 B     | 1, 1,507,328 B    |
| service worker (scanner and suffix lookup)    | 2, 1,507,328 B     | 1, 1,507,328 B    |
| rewrite workers, two of them used             | 2, 5,767,168 B     | 2, 6,029,312 B    |

A thread that calls one member alone (a rewrite worker, a page's worker)
holds the others' data as well: 128 KB more an instance. A proxied tab
saves 1,088 KB in its top's library realm, so it comes out ahead while it
has fewer than eight dedicated workers that evaluate text at once.

**What the wasm side costs in exchange.**

- Bytes, once per controller: `core.wasm` is 588,207 bytes (215,404
  brotli), fetched by the controller, cached by HTTP like any asset, and
  compiled once (off the main thread). The service worker is handed the
  bytes with each handshake and compiles them once more. Against that,
  every proxied frame stops fetching, parsing and holding 399 KB of
  script.
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
  fallback has to exist for them. It is in no bundle (built, phase 2 step
  4): the library as it was is an asset of its own (`rewriterLib.js`, the
  key `rewriterLib` in `Assets`), one file for documents and workers, asked
  for as `rewriterLib.js?<hash of its bytes>` so that a deploy never pairs
  one build's library with another's bundle and a host may let browsers keep
  the file for good. What a realm holds is the light library
  (`src/rewriterLight.ts`): the same calls with no parser and no printer
  behind them. The worker bundle carries it; the document bundle does not
  (41 KB: a frame uses its top's library and evaluated none of it), and the
  document's light library is the file's second statement instead
  (`__stompRewriterLight`, after the library's), which every top's shell
  loads already. A realm without it (a frame's own copy, a top the page
  made) takes its top's text, or the file's, as it does the library's
  (`lightFactory` in `src/inject/rewriter.ts`). A call that needs the rewriter library it does not hold stops
  and says so; the realm that asked hands it the file's text, and the
  library evaluates it in its own realm with the globals it captured (its
  realm is detached, and a detached realm cannot make a request: `send`
  throws, Chrome 152 and 156). That happens the first time one of these
  does:

  | Inject path                          | Served by                         | The fallback loads when                                               |
  | ------------------------------------ | --------------------------------- | --------------------------------------------------------------------- |
  | `modifyJS` (every path of phase 2)   | the rewriter module               | no module yet; the module declined the script or trapped              |
  | `singleExpression`, `parsesAsScript` | the rewriter module (parse only)  | no module yet                                                         |
  | `printExpression`                    | the fallback, until phase 5       | something threw and its message names a part of the page's expression |
  | `modifyCSS`                          | the scanner module (phase 3)      | no module yet, or it trapped; a data: sheet nested past the fourth    |
  | `getDomain`, `getPublicSuffix`       | the shell, then the suffix module | no module yet, for a host no shell named                              |

  Every row is cut over. The last two were cut second, once their modules
  answered in the page (step 3 and phase 3): the document bundle's light
  library carried css-tree and tldts until then
  (`src/rewriterLightDocument.ts` handed them to it as parts), because
  without the modules every top would have loaded the file for its first
  style or cookie. That entry now asks the scanner and suffix modules and
  nothing else; a part an entry does not answer is the fallback's, with no
  other change, and that was the whole cut. What it costs is with `'wasm'`
  alone, in the time before a top's modules arrive: a stylesheet a script
  writes then, or a host no shell named, loads the fallback into the top's
  library, as a script rewritten then already did (from the text the shell
  loaded, without a request). With `'js'` a top's library is the file
  itself, as before. A rewrite in the middle of another (a `data:` script
  that a script the module is rewriting imports, a `data:` stylesheet in a
  stylesheet) is a second instance's of the module, down to the fourth one
  inside another ("Instance memory" in section 6); past that it is the
  fallback's: without it the outer call is marked as needing it and made
  again once it is there.

  Where the text comes from. The service worker writes the file's script
  into every proxied top's shell, before the bundle: the parser fetches
  the two together, and the bundle takes the factory the file assigned and
  deletes the name (made non-enumerable by the shell, gone before any page
  script). With `rewriter: 'js'` the top's library realm is made from that
  factory and is the rewriter library itself, as it was when the bundle
  carried it. With `'wasm'` the realm holds the light library, and the top
  hands it the factory's text when a call needs it. A frame gets no such
  script: it shares its top's library and asks its top to load it. The
  first design had the realm that asked fetch the file with a synchronous
  request instead, and two measurements ended it. With `'js'` it cost
  every top 4 to 5 ms before its first script; with the shell's script a
  top is 3 to 5 ms faster than before the split (`measure-first-rewrite`,
  from navigation start to the first page-side rewrite answered, 3 x 120
  warm navigations on Chrome 152 and 156: the fastest 31 to 34 ms against
  34 to 38 ms, the lower quartile 33 to 41 ms against 39 to 48 ms). And
  on a document's main thread the browser reports a synchronous request
  as deprecated, to the page's own ReportingObserver, naming the inject
  bundle: `error-surfaces` caught it.

  How often the fallback is needed with `'wasm'`, on nine fixture pages
  (`rewriter-fallback` prints the counts): three never need it, six need
  it once (four did while css-tree and tldts were in the light library),
  and in every one of the six the first cause is a rewrite the page asked
  for before its modules had arrived (a function made from a string,
  `document.write`, a worker or a style written in the page's first
  task). The module declined 2 of 124 calls on the error messages page and
  none elsewhere. A top that got its modules before its first script
  would seldom evaluate the fallback at all.

  The controller fetches the file when it starts, under both backends, so
  it is in the HTTP cache before the first proxied page exists, and a host
  that does not serve it fails there (`wait()` rejects, naming the asset's
  key) instead of in some page later.

  A document's own site and its top's are needed while the client is made,
  before any message can have arrived: the service worker, which keeps tldts
  (its bundle is one per scope, not per frame), writes them into the shell
  (built: "The shell carries the site" below). A realm the module cannot
  reach at all keeps a light library of its own and loads the fallback on
  its first rewrite. A document sandboxed with an opaque origin is handed
  the text by its top, as a string; where its script policy refuses eval (a
  sandbox without allow-scripts) the text is run as a script with the
  policy's nonce instead. A page's dedicated worker is in its document's
  agent cluster and is handed the module with its transport port, and so is
  a page's emulated service worker, a dedicated worker of the controller's
  (built: "A page's workers", which also says what a worker evaluates before
  the module can have reached it); a shared worker is not. A worker fetches
  the file with a synchronous request (3 to 7 ms from the HTTP cache for the
  471 KB), which no report follows there, the first time it needs it: a
  worker handed the module only for what the module has not arrived for or
  declines, a shared worker and every worker under `rewriter: 'js'` for
  every rewrite. So does a frame under a top of another build (during a
  deploy), the one document that still makes that request: its page is not
  shown the deprecation report (`applyReports` in
  `src/inject/modules/Unroute.ts`). A rewrite that can be made by neither
  backend (the fallback did not load) is refused, as a failed rewrite is
  today: the script does not run unrewritten.

- _The public suffix list._ A table of its own, not a crate's: the `psl`
  crate compiles the list into match code, which costs more than the data
  does, and `publicsuffix` parses the list's text at startup. Built
  (`rust/suffix`, `suffix.wasm`): the list is vendored byte for byte at
  `rust/suffix/src/public_suffix_list.dat` and pinned beside it
  (`src/pins.env`: publicsuffix/list 52b71b3c of 2026-10-17 and the file's
  sha256, which `build.rs` checks before it builds anything). Vendored and
  not fetched, so the toolchain image does not change with the list and a
  build needs no network for it; the pins are in the artifact's `UPSTREAM`.
  `build.rs` turns the rules into a trie by label from the right, names
  equal subtrees once and writes it as four byte tables (70,776 bytes for
  10,857 rules); the crate has no dependency, no allocator and no `std` on
  wasm, and searches the tables by label.

  The module answers what tldts answers, not what the list's own
  algorithm would: `getDomain` and `getPublicSuffix` for any string (a
  host, a URL, neither), with the private section or the ICANN section
  alone. That means tldts's hostname extraction and validation, its trie
  walk (the exact label before the wildcard and no way back, a wildcard
  matching an empty label, the six suffixes it answers before the table)
  and its two spellings of a rule that is not ASCII, which a host has to
  keep to. The answer is where the piece stands in the input, in UTF-16
  code units, and the glue (`src/wasm/suffix.ts`) slices it; the two things
  tldts does with the string itself (ECMAScript's lower case, dropping
  tabs and newlines) are the glue's, each one more call. `src/suffix.ts`
  is the one place a bundle asks: the module when the thread holds it,
  tldts otherwise.

  | `suffix.wasm`                                  | Measured                               |
  | ---------------------------------------------- | -------------------------------------- |
  | size                                           | 81,416 bytes, 38,783 brotli            |
  | (tldts in the inject bundle)                   | (131,888 bytes)                        |
  | compile, instantiate                           | 0.1 ms, 0.07 ms                        |
  | instance memory                                | 196,608 bytes (three pages)            |
  | lookups a second, a million distinct hosts     | 0.3 to 0.6 million (tldts: 1.5 to 2.1) |
  | lookups a second, 2,000 hosts asked over again | 8 to 11 million (tldts: 1.6 to 2.1)    |

  (On a machine under load, across runs.) A lookup that reaches the module
  costs three to five of tldts's, nearly all of it the boundary (the string
  encoded in, the call, the answer decoded), so the glue keeps the last
  2,048 answers: a browsing session asks about the same few hosts with
  every request. The estimate before it was built was 130 KB, 45 KB brotli.

  Parity is a harness and a suite. `rust/host/suffix.mjs` compares the
  module with tldts over every rule of the list (as the list spells it and
  in punycode, the rule itself and one and two labels under it, each
  wildcard and exception case, upper case, trailing dots, as a URL), every
  host and URL in the test data, IDN, IP and malformed forms, and a seeded
  fuzz: 5,517,300 comparisons at a million fuzz inputs, no differences. It
  also compares the pinned list with the table of the tldts the lockfile
  pins (10,857 rules either way), so a tldts update that knows a rule the
  list does not fails until the pin is raised, and runs the list's own
  `test_psl.txt`: the module and tldts agree on all 77 vectors, and both
  differ from the file on the two hosts with a leading dot, where tldts
  answers the domain. The `suffix` suite runs the harness with a smaller
  fuzz and holds the artifact to a budget (90,000 bytes, 42,000 brotli).

  Who asks it under `rewriter: 'wasm'`: the service worker (a request's
  fetch-metadata site, a route's storage partition, the cookie jar, the
  blocker's import), and a proxied top's rewriter library for the frames
  under it, each handed the module as it is handed the rewriter. The
  rewrite workers hold it and compute no site.

- _The shell carries the site._ The service worker writes into each
  document's shell what the list says of the document's host and of its
  top's (`src/siteFacts.ts`): for the host and every name above it, the
  registrable domain and the public suffix, both with the list's private
  section, which is where Chrome ends a site (two customers of `github.io`
  are two sites; measured, `docs/same-origin-policy.md`), as spans of the
  host (67 bytes for `www.example.co.uk`).
  Every name, and each asked on its own, because a name's suffix does not
  follow from the suffix of the name below it (`city.kobe.jp` is
  registrable under `kobe.jp`, whose own suffix is `jp`). The inject keeps
  them by name (`src/inject/sites.ts`) and asks the list only about a name
  no shell gave it; a shell the page realm writes (an srcdoc, a blob:
  document) hands on what its bundle was told. What that answers without
  a list, in every realm and before any module arrives:

  | The inject asks                                         | About                                 | Answered by                                 |
  | ------------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
  | a document's site key (the window membrane)             | its own host                          | the shell                                   |
  | its storage partition                                   | its own host and its top's            | the shell (the nested route names the top)  |
  | the key its cookie cache is versioned by                | its own host                          | the shell                                   |
  | a cookie's `Domain` (is it a public suffix)             | the host or a name above it           | the shell                                   |
  | a `document.domain` write (is it a public suffix)       | a name above the host                 | the shell                                   |
  | `frameElement`, a window of another document            | the two documents                     | each document's own site key                |
  | whether a navigation's target is of the document's site | the target's host, when it is another | the list, unless a shell named the host     |
  | a cookie's `Domain` that is no name of the host         | that name                             | the list (the cookie is refused either way) |

  The last two are what is left for the list in a page: the suffix module
  in the top's library when it has arrived, the fallback otherwise. The
  `site-facts` suite counts them: a page, a frame of its site on another
  host, a frame of another site, an srcdoc frame and a frame two deep ask
  the list nothing for the first six rows.

What is left of the library in the bundle after the removal: the codecs and
URL routing (the 18,632 bytes of crypto-js and STomp's own routing code),
the wasm glue, and the fallback's loader. The file carries the codecs and
the routing code as well: with `'js'` it is the whole of a top's library,
so it has to stand alone, and a realm that loads it beside a light library
evaluates those 30 KB twice.

**As built (step 4, on the series up to the CSS rewriter in the scanner
module).** In two changes: meriyah, escodegen and the rewriters on them
first (css-tree and tldts still in the light library), then css-tree and
tldts. Bytes, with brotli in brackets:

| File                     | Before            | Parsers out       | css-tree and tldts out |
| ------------------------ | ----------------- | ----------------- | ---------------------- |
| `dist/injectDocument.js` | 860,006 (224,309) | 633,099 (173,356) | 428,139 (114,967)      |
| `dist/injectWorker.js`   | 440,982 (110,609) | 213,903 (59,461)  | 214,001 (59,429)       |
| `dist/rewriterLib.js`    |                   | 471,109 (122,541) | 471,109 (122,541)      |

The heap one proxied frame adds does not move (1,089 to 1,096 KB with 20
frames before and after, both backends, Chrome 156): a frame
never evaluated the library, and its text in the bundle cost a frame about
3 KB. What a frame saves is the 432 KB it no longer fetches, scans and
keeps a copy of.

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
domain through its one import, answered by what the worker asks for its
own sites (`src/suffix.ts`: the suffix module under `rewriter: 'wasm'`,
tldts otherwise), so the public suffix list is not in the artifact twice.

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
- **The option.** On by default since 2026-11-10 (`adblock: false` turns it
  off; left out it is best effort, docs/adblock.md "By default"). `true` or
  an object with list
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

The glue asks a module only when it answers the revision the glue was
written against (`REVISION` in `src/wasm/rewriter.ts`, flag 32), for a
rewrite and for what parses: the artifact is fetched apart from the
bundles, and the phase 0 artifact, which copies its input, would otherwise
hand a script back as the page wrote it (`wasm-rewriter-glue` suite). So
the revision is raised with the boundary as well as with the output: a
module that takes a flag the last one did not is another revision.

The request log says which backend rewrote a script (`rewriteBy`): the
module, or the JavaScript rewriter when the module declined the script, its
thread holds none, or the script was split.

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
   port (built: "A page's workers" in section 6, the `worker-rewrites`
   suite), and the page's instance gets a memory threshold of its own
   (built: 8 MB, "Instance memory" in section 6, the `wasm-instances`
   suite);
3. the suffix module (`suffix.wasm`, its table built by `rust/suffix` from
   the pinned list), with the parity suite against tldts, and the service
   worker writing a document's own site and its top's into the shell
   (built: the service worker and a top's library ask the module, the
   shell carries the site);
4. the JavaScript library becomes the asset `rewriterLib.js`, loaded on
   first need as section 6 sets out, and meriyah, escodegen, css-tree and
   tldts leave `dist/injectDocument.js`: **at most 415,585 bytes** against
   814,491 on master, with the `frame-cost` bundle budget lowered to 430 KB
   in that change (built, in two changes: 428,139 bytes against the
   860,006 the bundle had grown to, under the 430 KB budget; "The target"
   in section 6 says why the byte count of master is not the measure);
5. the suites of section 10 under both backends, and `frame-cost`,
   `wasm-share` and the new suffix suite in the gate.

Step 4 needs the CSS scanner of phase 3 in the page (it adopts every module
the controller sends, so the scanner arrives with the rewriter) and a host
that serves one more asset; both `'js'` and `'wasm'` keep working, with
the file loaded by a top's shell.

**Phase 3. CSS and the markup scan, where they pay.** `rewriteCSS.ts`
already emits an edit list and parses lazily, so the Rust version is a
tokenizer level scan with the same output; the gate is byte-identical output
on the 142 sheet corpus. `prewrite.ts`'s regex scan of `<script>` and
`<style>` becomes a Rust scanner. The real HTML parse stays where it is, in
the page's own `DOMParser`: it is correct and free.

As landed (`rust/rwcss`, `scanner.wasm`, `src/wasm/scanner.ts`): the module
rewrites. Its first form only found the raw pieces worth looking into and
JavaScript rewrote each one; now all of `modifyCSS` for a stylesheet or a
declaration list (an element's `style`), and `rewriteCSSValueURLs` for a
single value, is in the crate, and the module's answer is the rewritten
text (or "unchanged", which costs no copy). The crate is css-tree 3.2.1
ported literally, in three layers:

- `css.rs`: the tokenizer, the token stream and the lazy node parsers
  (error recovery included: `parseWithFallback`, the balance table, the
  at-rule block table). They find the pieces that could hold a URL: a
  declaration's value, an at-rule's prelude, a rule's prelude, text no
  parse shaped. A piece is looked into when it holds `url(`, `image-set`
  or `src(` (every case that can produce an edit; found in one pass over
  the sheet), or is an `@import` prelude.
- `full.rs`: the parse css-tree gives one such piece, tokenized on its own
  as css-tree does: the value, selector list and at-rule prelude parsers
  (`@import`, `@media`, `@supports`, `@container`, `@scope`, `@layer`,
  `@page`, `@nest`; conditions, features, ranges and ratios; selectors with
  their pseudo-class parsers, `An+B` and attribute selectors), kept to
  what the rewrite reads: where each Url, String and Raw stands, and the
  function, pseudo-class and at-rule it stands in. The quirks a literal
  port keeps are kept (a feature named `constructor` reads as a general
  enclosed; `eof` stays set after a fallback; a lone `#` is stepped past
  before the missing name is reported).
- `rewrite.rs`: `route` and `deep` of `src/rewriteCSS.ts` and what they
  call: css-tree's string and url decoders and its url encoder,
  `JSON.stringify`, `decodeURIComponent`, the two URL expressions of
  `src/cssURLs.ts` with JavaScript's `\s`, `.` and backtracking order,
  `originalOf`, `preserveValue`, and the edit list, spliced into the text
  in the module (an edit that overlaps an earlier one is dropped, as
  `Edits.replace` drops it).

What stays on the thread is what a URL routes to, because the base URL,
the codec and the config live there. The module asks through its routing
import (`e.r`, as the JS rewriter's module does): a kind (a URL the
expression found or a string of `image-set()` or `src()`, a `url()`, an
`@import`'s `url()`, an `@import`'s string) and the URL text, and is
answered the routed URL, or -1 to leave the piece as written (the text is
no URL, or an `@import` that is routed already).

The crossing. A rewrite does not go through `r`: the module keeps an input
buffer from call to call (`i(len) -> ptr`), the thread encodes the text
straight into it (`encodeInto`, no array and no allocation per call) and
calls `x(len, flags) -> status`, and a routed URL is written into a scratch
the module makes as large as the answer (`s(len) -> ptr`: a data: URL,
which `preserveValue` carries twice, can be megabytes). Past 1 MiB either
buffer is given back after the call. `BufferInstance.exchange`
(`src/wasm/module.ts`) is that call, beside `call`, which the rewriter
module and the markup scan keep; it reads what comes back with a decoder
that keeps a byte order mark, and a surrogate with no other half crosses
both ways as the three bytes its code point would take (WTF-8: the thread
encodes and decodes those itself, only for a text that holds one). The
module copies such bytes as it copies any others, and its `JSON.stringify`
writes one as `\udXXX`, as JavaScript does. `r` answers "unknown flag" for
a rewrite, so a glue older than the module rewrites in JavaScript, and a
glue newer than the module (no `x` among its exports) does too.

One call per URL, not a batch. Measured on a sheet of 5,000 rules with a
URL each (0.53 MB), best of 15 runs: the rewrite takes 33.6 ms; the same
with every call answered at once by a fixed string, 11.5 ms; with every
call answered -1, 7.5 ms; with no `url(` in the text at all, 4.1 ms; and
routing the 5,000 URLs in JavaScript alone (`new URL`, the codec), which a
batch does all the same, 16.9 ms. So everything a call adds (the crossing,
the text decoded, the answer encoded and copied) is under 7.4 ms, 1.5
microseconds a URL, and a batch could save part of that at the price of a
second pass in the module (collect, then splice). On the real corpus
(1,690 URLs in 11.9 MB) the calls are under 2.5 ms of 77.

The gate is identity, and the module answers every text itself: it
declines no stylesheet, declaration list or value (its first form declined
a lone surrogate, a URL that begins with U+FEFF, deep nesting, a large
sheet and a token past the end of the text, and css-tree rewrote those).
What is left to JavaScript is a thread with no module, an instance that
trapped, and a stylesheet nested past the fourth level: a `data:`
stylesheet imported by a stylesheet asks for the module as the sheet around
it did, and is rewritten by a second instance of it ("Instance memory" in
section 6), down to the fourth sheet inside a sheet.
css-tree's walker compares an at-rule's name as written, so `@IMPORT
url(x)` routes as an image and `@IMPORT "x"` is left alone; the module does
the same. Where css-tree itself has no clean answer the module has one:

- Nesting. css-tree recurses, and V8's stack ends at 1,400 to 3,000 levels
  of blocks or brackets, by the shape and by what else is on the stack.
  Where its parser runs out the innermost `parseWithFallback` takes the
  rule or value as raw text, whose url()s the expression routes; where its
  walk of the finished tree runs out `modifyCSS` throws, and its callers
  route the whole text by the expression (so an `@import "x"` of that sheet
  is not routed at all). The port recurses too, on the stack the host gives
  a wasm call (V8 stops it at 2,300 to 5,000 levels), so it stops at 1,024
  (`MAX_DEPTH`, `MAX_NESTING`), always, and what is deeper is raw text: the
  first of css-tree's two answers, with the rest of the sheet parsed. From
  1,024 levels to where css-tree runs out the two differ in spelling only:
  css-tree still parses and writes `url(x)`, the module writes the
  expression's `url("x")`. The deepest of the 2,396 corpus sheets nests
  24 brackets.
- Size. css-tree keeps a token's offset in 24 bits: in a sheet of more than
  16,777,215 UTF-16 units what follows that point is no longer parsed. A
  url() there is still routed, by the expression; an `@import "x"` there
  is left as written and loads from the origin, unproxied. The module's
  offsets are whole and it rewrites the sheet to its end. This is the one
  place the module's output is deliberately not css-tree's.
- A token css-tree ends past the end of the text (an escape cut off at the
  end of a bad `url(`): the end of the text, which is what every reader of
  that token's end made of it.
- A parse that stops advancing (css-tree's own loop would never end): the
  module answers status 8 and `modifyCSS` throws, for its caller's own
  catch (the expression in the service worker, the value left alone in a
  frame). No text of the corpus or of 560,000 fuzzed ones gets there.

It first declined a closing bracket with nothing open as well, because
css-tree's own answer for one depended on the sheet it had parsed before:
it reads the token at index `source.length` of a buffer it keeps between
parses and never writes there. That was a bug of the JavaScript path, not a
limit of the port (the same sheet parsed differently from load to load,
and the fuzz found a pair of sheets whose second never stopped parsing), so
`src/rewriteCSS.ts` now clears the buffer after every parse
(`css-parse-history` suite) and the module answers such a sheet as
css-tree does with a clean one.

Parity. The corpus on disk is 99 sheets (11.9 MB: `csscorpus`, YouTube's,
CNN's), not the 142 this plan named; a wider sweep is 2,297 stylesheets
from this machine's caches and packages (57.8 MB). All 2,396 rewrite byte
for byte the same in the module and in JavaScript, none declined (1,104
hold something to route and are the module's; the rest never leave the
`MAY_ROUTE` test). The `scanner-parity` suite holds the hand-written cases
(108 stylesheets and declaration lists and 20 values, then lone
surrogates, byte order marks, nesting to 20,000 levels, a sheet and a
routed URL of megabytes, a sheet past 16.7 million units: every one the
module's own answer), every stylesheet and document under `test/pages`, the
inject library's path, and a seeded fuzz that mutates them (`SCANNER_FUZZ`
rounds, `SCANNER_CORPUS` for a corpus directory); it needs no browser. At
`SCANNER_FUZZ=240000` it compares 320,000 mutated stylesheets and
declaration lists and 240,000 mutated values with no difference; the
module answers 358,597 of them and declines none, and the rest hold
nothing to route.

Speed, in node, best of 9 passes over the 99 sheets: css-tree 553 ms, the
module's first form (it found, JavaScript rewrote) 145 ms, the module
77 ms, 154 MB a second. About 12 ms of the 77 is the thread encoding the
text to UTF-8 (8.5 ms of it since the text is encoded in place) and 6 ms is
routing; the module's own work is about 40 ms.
The wider sweep takes 0.5 s against 54 s. An element's style of 57
characters takes 5.0 microseconds against css-tree's 9.1. A single value is
the one place the module loses: 2.9 microseconds for the expression
against 3.7 through the module (4.7 before the text was encoded in place),
and 14 ms against 35 for the 99 sheets taken as values. Of either, 2.3 is
routing the URL itself (`new URL`, the codec), which both do; the call
into the module and the URL's text coming back out cost 0.6 before
anything is answered, which is all the expression takes for its whole
match. So `rewriteCSSValueURLs` takes the module only when asked and no
caller asks. Built for speed (`opt-level = 3` for the crate) the module is
91 KB (27 KB brotli) and its own work about 15% faster; it is built for
size like the others.

Callers. The service worker's `/css/` route (the request log says
`rewriteBy: 'wasm'` or `'js'`) and a prewritten document's markup and
inline styles, under `rewriter: 'wasm'`. Both are asynchronous, and wait
for a scanner that is still being compiled (`scannerSettled`): a worker
that Chrome stopped starts again holding nothing, is handed the modules'
bytes with its controller's handshake and has them compiled 2 to 6 ms
later. Measured over CDP restarts on Chrome 152 and 156, the first
stylesheet's body was in hand 5 to 10 ms after that when the stylesheet
itself woke the worker, 35 to 60 ms when a navigation did, and over 200 ms
after for a controller just created, so the wait was 0 ms in 18 of 18; it
is there for the sheet that does win the race (with the compile slowed to
300 ms that sheet is the module's with the wait and css-tree's without,
`wasm-share` suite). The route does not wait for bytes still on the
network (a controller that has not finished loading its modules). In the
page, the rewriter library
(`src/rewriterLibDocument.ts`) asks for the module on every stylesheet and
style attribute a frame has it rewrite: a proxied top is handed every
module its controller compiled (phase 2's delivery, `adopt` by name), so
the top's library holds `scanner` beside `rewriter`, for itself and the
frames under it, and css-tree answers until the module has arrived and
wherever it cannot (a tab in another agent cluster, a sandboxed document
with an opaque origin). The `css-inject-backend` suite writes a style
element, `insertRule`, `replaceSync`, a style attribute and `cssText` from
page script under each backend and reads which rewrote them from the
library's own count (`styleRewrites`), since the text is the same. A
frame's single values (a CSSOM property set, a presentation attribute)
stay on the expression in the frame.

What still needs css-tree, which is 69 KB of the minified service worker
(627,999 bytes) and was 71 KB of `injectDocument.js` (840,295;
`source-map-js` is in neither since phase 2 put `src/noSourceMaps.ts` in
its place): nothing calls `modifyCSS` with a context other than the two
the module rewrites, so what is left is the fallback. Only
`src/rewriteCSS.ts` imports css-tree, and only `src/server/rewrites.ts`
and `src/rewriterLibDocument.ts` (the fallback asset) import that; its
head (the `MAY_ROUTE` test, the module's call) needs no parser, and is
all the inject bundle keeps of it (`src/rewriterLightDocument.ts`: phase 2
step 4 took css-tree out of that bundle, with the fallback asset as the
other answer below). For css-tree to leave the service worker, each of
these needs another answer than css-tree:

- a thread that holds no module: `rewriter: 'js'` (the default), a module
  that has not arrived yet (the service worker waits for one that is being
  compiled; a frame's library cannot wait at all), a document outside the
  controller's agent cluster, an instance that trapped;
- `data:` stylesheets nested five deep, each imported by the one around
  it: the first four are the module's, each in an instance of its own
  (`src/wasm/thread.ts`), and the fifth asks css-tree. `routeCSS` rewrites
  it inside the synchronous rewriters, so whatever answers has to be in
  hand before the rewrite around it starts.

Nothing about a text itself sends it to css-tree any more (above).

**Phase 4. The blocker.** The second artifact, the service worker's network
path, the cosmetic and scriptlet paths, redirect resources, the option, the
demo toggle, docs and suites.

**Phase 5.** `rewriter: 'wasm'` becomes the default once the parity suites
have been green across a few nightlies, and the JavaScript library is then
only the fallback asset of phase 2: no bundle carries meriyah, escodegen,
css-tree or tldts, and the budgets phase 2 lowered stay where it put them
(`injectDocument.js` at most 430 KB in `frame-cost`, 428,139 bytes as
built). Optional: `callPrinter.ts` in Rust, which would stop an
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
  uses none of it), `scanner-parity` (phase 3: `modifyCSS`,
  `rewriteCSSValueURLs` and the prewrite scan with the scanner module and
  without, byte for byte), `wasm-share`
  (every thread that rewrites holds the
  modules the controller loaded once, a top's library holds the module and
  a frame under it makes no library of its own), `worker-rewrites` (what
  classic, module, blob:, nested, framed and service workers evaluate from
  text reads as it does natively under both backends, and under `'wasm'`
  is the module's rewrite from the worker's first message on),
  `wasm-instances` (a thread's instances: replaced past the memory limit
  with the same rewrites before and after, a second one for a rewrite made
  during a rewrite), `wasm-artifact` (no name
  or producers section, no project token in the bytes, every export
  renamable, the flags and statuses of the ABI), `suffix` (the suffix
  module's boundary, budget and glue, and its parity with tldts through
  `rust/host/suffix.mjs`), `site-facts` (what a shell says of a host is the
  list's answer for it and every name above it, and a document asks the
  list nothing about itself), and in phase 4 the three blocker suites. The corpora are not a suite: they live in `/tmp` and
  take minutes, so `rust/host/parity.mjs` runs them by hand each phase.
- **Differential harness.** `rust/host/parity.mjs` runs the artifact and
  `modifyJS` over the same scripts in Node, so a disagreement is found
  without a browser (no native binary: the artifact under test is the one
  that ships). The two do not print alike, so each output is parsed again
  and the programs are compared as trees, the function marks as lists and
  the holder as text. `--cases` runs `rust/host/cases.mjs` (every family by
  shape, and a `holes` family for each hole the JavaScript rewriter had,
  what its fix changed: 814 scripts), a directory is a corpus. A script
  the module declines is counted apart with its reason, and one the module
  rewrites but meriyah refuses is a failure, which is the parse parity
  sweep. `--cases` also holds the module's revision to its outputs
  (`cases.revision`). The `rewriter-parity` suite runs `--cases` with the
  module the build ships and fails on any difference, known divergence or
  hole case the module declines. A hole in one rewriter is fixed in both
  in the same change, or a case shows the other never had it (the wasm
  rewriter keeps the page's text, so a parenthesis the JavaScript printer
  dropped it cannot drop). A pattern moved where it has a source (a
  parameter's, a loop head's, a catch clause's) names the page's text in
  the error its source throws under the wasm rewriter and the declaration
  made of it under the JavaScript one; the harness does not compare those
  two strings.
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
| Per-frame heap and RSS        | ceiling 1,160 KB                 |

Phase 1, measured (2026-11-10, Node 24, load about 20; medians of three):

| Measurement                                      | JavaScript | wasm                                                                     |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------ |
| the 46 MB corpus (28 scripts), rewrite only      | 13.6 s     | 2.0 s (6.7x)                                                             |
| Discord's 12 MB `web.js`, whole, one thread      | 3.1 s      | 0.43 s                                                                   |
| parity, the corpus                               |            | 28 of 28 the same                                                        |
| parity, 1,309 files of `node_modules` over 2 KB  |            | 1,309 the same                                                           |
| parity, the 680 cases                            |            | 675 the same, 0 differ, 1 known divergence, 1 declined, 3 neither parses |
| artifact                                         |            | 469,012 bytes, 164,914 brotli (the check in the walk, patterns scanned)  |
| `dist/injectDocument.js`, master and this branch | 814,491    | 816,570                                                                  |

## 12. Risks

| Risk                                                                                             | Handling                                                                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| oxc and meriyah disagree on what parses (webcompat, global return, V8 intrinsics, HTML comments) | the parse parity sweep over the corpora; a disagreement falls back per script                       |
| the optional chain rewrites are the hardest to express as edits                                  | their own differential corpus, the coverage macro, and a per-script fallback until proved           |
| nested or overlapping edits                                                                      | the nest-aware engine, property tests, and a failed rewrite falls back rather than emitting garbage |
| wasm instance memory never shrinks                                                               | allocator reset, instance replacement past a threshold, idle drop in the service worker             |
| a per-frame wasm instance would blow the frame-cost ceiling                                      | the instance lives only in the shared library realm; `wasm-share` asserts it                        |
| the fallback library is fetched synchronously where a rewrite cannot wait                        | only a worker or a frame under a top of another build fetches it; a top's shell loads it, section 6 |
| the suffix table goes stale against tldts                                                        | the pin is raised with the nightly, and a suite compares the two over a host corpus                 |
| the artifact carries a token or a name section that a host's canary scan would reject            | the build fails on it, so it cannot ship                                                            |
| no Rust toolchain on this machine (no rustup, cargo, wasm-opt or wasm-bindgen)                   | everything is built in the container, as epoxy is                                                   |
| blocker list fetches fail, or a list licence is awkward to redistribute                          | lists are fetched at runtime, nothing is vendored, and a failed fetch leaves the blocker off        |
| the blocker adds a tell                                                                          | a blocked request is a plain network error; the `tells` suite gains cases                           |
| other agents land in `src/inject` and `src/server` continuously                                  | rebase onto `origin/master` before every phase and before every gate run                            |

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
