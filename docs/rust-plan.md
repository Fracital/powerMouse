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
├── Cargo.toml          workspace, pinned oxc, the release profile
├── rust-toolchain.toml nightly pinned by date, wasm32 target, rust-src
├── edits/              the span edit model and the splice engine (no oxc AST)
├── rwjs/               the JS rewriter: oxc parse, visitor, edits
├── rwcss/              the CSS url scanner (phase 3)
├── scan/               the markup prewrite scanner (phase 3)
├── block/              adblock-rust wrapped for the service worker (phase 4)
├── coverage-macro/     the build time walk proof
├── abi/                the hand written wasm glue side: exports and one import
└── host/               a native binary: differential tests and benchmarks
deploy/rust/
├── Dockerfile          pinned base image, rust, wasm-bindgen free, binaryen
├── build.sh            builds in the container, copies artifacts out
├── pins.env            every version that goes in
└── README.md
```

Two artifacts, built separately so a deployment that wants neither pays for
neither:

- the rewriter module, about 600 KB, 160 KB brotli.
- the blocker module, measured in phase 4 (the crate's regex and idna tables
  dominate; expect a larger one).

Both are committed under `assets/` with a `.sha256` and an `UPSTREAM` file
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
   the input, the offsets are exact rather than reconstructed.
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
7. **Split equals whole, byte for byte**, as today: a part is a verbatim
   substring and its edits depend only on the code inside it, so
   `splitSources` and `stitch` need no change.
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

| Export | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| `m`    | the memory                                                  |
| `a`    | `alloc(len) -> ptr`                                         |
| `f`    | `free(ptr, len)`                                            |
| `c`    | `configure(ptr, len) -> status`, the config once per change |
| `r`    | `rewrite(ptr, len, flags) -> status`                        |
| `p`    | the result pointer                                          |
| `n`    | the result length                                           |
| `s`    | the status word (0 ok, otherwise an error code)             |

One import: `route(kind, ptr, len) -> packed`, which the host answers by
writing a routed URL into a scratch buffer. URL routing stays in TypeScript
(`StompURL`, the codecs, `routeURL.ts`): duplicating it in Rust would be a
second source of truth for the thing most likely to leak an origin.

`configure` is called once when the config changes, never per rewrite: the
helper names, the routed name list, the flags and the directory cross once.
`rewrite` takes the script bytes and a flag word (module, worker, compact,
allow invalid, keep sources here) and answers the output bytes plus, when
asked, the edit log for the round trip test.

`panic = "abort"` means a Rust panic is a wasm trap. The glue treats a trap
as "this instance is dead": it drops the instance, keeps the compiled module,
and falls back to the JavaScript rewriter for that script.

### One module, many realms

`WebAssembly.Module` is structured cloneable and can be posted to a worker in
the same agent cluster. So:

- the controller compiles the module once (from a URL, bytes or a module the
  host hands over) and posts it to the service worker with the handshake and
  to every rewrite worker when it starts them.
- the service worker keeps one instance for its own thread.
- each rewrite worker keeps one instance.
- in the page, the instance lives in the shared rewriter library realm
  (`src/inject/dom/rewriterRealm.ts`), which a top makes once and its frames
  share. A frame never instantiates anything: it already speaks to that
  realm in strings only. A document with no shareable top (a sandboxed frame
  without `allow-same-origin`, a worker) instantiates its own on first use,
  exactly where it evaluates its own JavaScript library copy today.

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
  limits. The module is posted to the top's client over the channel the
  controller already speaks to its frames on (a `WebAssembly.Module` clones
  within the agent cluster, and the controller frame and the proxied frames
  share the proxy origin in both modes), with the rest of the inject
  bootstrap. Until it has arrived, and in any realm it cannot reach, the
  JavaScript backend answers: the inject's rewrites are synchronous, and a
  script that needs rewriting before the module is there cannot wait for it.
  That is the same per-script fallback the workers use, so a document whose
  first inline script runs before the module lands is rewritten correctly,
  just by the slower backend.

The rewrite workers hold no config between requests today (every
`RewriteRequest` carries the whole config). The worker keeps the last
config's JSON, as `src/rewriterLib.ts`'s `enter` does, and calls `configure`
only when it changes, so the once-per-change rule holds without a new
message. The rewrite cache keys on the config, so the backend choice becomes
part of the key on its own, as it must: the two backends' outputs differ.

Per-frame cost therefore goes down, not up: the frame stops paying for
meriyah's and escodegen's tables. The `frame-cost` ceiling (1,120 KB per
frame, `injectDocument.js` at most 850 KB) is a gate on every phase, and the
bundle shrinks as the JavaScript rewriter leaves the inject (phase 2, behind
the option: both backends ship until the wasm one is the default).

### Instance memory

wasm linear memory never shrinks. A 13 MB script will grow an instance to
tens of megabytes and keep it. Three mitigations, all measured in phase 1:

- `Allocator::reset` after every rewrite, as scramjet does.
- an instance that has grown past a threshold is dropped and replaced
  (cheap: the module stays compiled).
- the service worker's instance is dropped when it has been idle, so a
  long-lived worker does not hold a Discord-sized heap.

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
`single-thread`, `css-validation` (required: without it procedural rules land
in `hide_selectors`) and `embedded-domain-resolver`. Dropped:
`resource-assembler` (it wants a filesystem), `content-blocking`,
`debug-info`.

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
- **The option.** `blocker: false` by default. `true` or an object with list
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

**Phase 2. The inject's main-thread paths.** The library realm instantiates
the module and `src/inject/rewriter.ts` routes `modifyJS` to it: inline
scripts in `loadHTML`, `eval`, `new Function`, string timers, `document.
write`, blob documents, `javascript:` URLs, worker and srcdoc bootstraps.
`printExpression` stays in JavaScript (it runs only when something already
threw). The split planner moves to Rust here, where the cold 0.9 s plan parse
is worth removing.

**Phase 3. CSS and the markup scan, where they pay.** `rewriteCSS.ts`
already emits an edit list and parses lazily, so the Rust version is a
tokenizer level scan with the same output; the gate is byte-identical output
on the 142 sheet corpus. `prewrite.ts`'s regex scan of `<script>` and
`<style>` becomes a Rust scanner. The real HTML parse stays where it is, in
the page's own `DOMParser`: it is correct and free.

**Phase 4. The blocker.** The second artifact, the service worker's network
path, the cosmetic and scriptlet paths, redirect resources, the option, the
demo toggle, docs and suites.

**Phase 5 (optional).** `callPrinter.ts` in Rust, and `rewriter: 'wasm'`
becoming the default once the parity suites have been green across a few
nightlies. Probably not worth it for the printer: it only runs on error
paths.

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
  hold for spliced output. Each gets a second expectation for the wasm
  backend, written as the input with named spans replaced, so both
  contracts are stated rather than loosened. The suite imports `modifyJS`
  directly, so it gains a backend switch of its own. Its `unmarked` helper
  strips the holder and the marks, which the wasm backend must emit byte
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
- **New suites.** `rewriter-parity` (the corpora through both backends: the
  untouched-bytes invariant, the edit log round trip, and a behavioural
  comparison), `wasm-share` (one `WebAssembly.Module` across realms and
  workers, and no instance per frame), `wasm-artifact` (no name or producers
  section, no project token in the bytes, every export renamable), and in
  phase 4 the three blocker suites.
- **Differential harness.** `rust/host` is a native binary that runs the
  Rust rewriter over a corpus, and a Node side runs `modifyJS` over the same
  corpus, so a disagreement is found without a browser. It also runs a parse
  parity sweep: oxc and meriyah must accept and reject the same inputs, and
  an input they disagree on falls back.
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

## 12. Risks

| Risk                                                                                             | Handling                                                                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| oxc and meriyah disagree on what parses (webcompat, global return, V8 intrinsics, HTML comments) | the parse parity sweep over the corpora; a disagreement falls back per script                       |
| the optional chain rewrites are the hardest to express as edits                                  | their own differential corpus, the coverage macro, and a per-script fallback until proved           |
| nested or overlapping edits                                                                      | the nest-aware engine, property tests, and a failed rewrite falls back rather than emitting garbage |
| wasm instance memory never shrinks                                                               | allocator reset, instance replacement past a threshold, idle drop in the service worker             |
| a per-frame wasm instance would blow the frame-cost ceiling                                      | the instance lives only in the shared library realm; `wasm-share` asserts it                        |
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
