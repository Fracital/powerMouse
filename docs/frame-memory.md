# What a proxied frame costs in memory

In same-origin mode every proxied frame is a frame of the host's page, so
all of them share one renderer process (docs/process-model.md), and the
proxy's service worker and its transport worker live in that renderer too.
A page that keeps hundreds of ad and sync frames pays every per-frame cost
hundreds of times in one process, and whatever the workers leave behind
lands in the same process. This page records where a frame's bytes go
against native Chrome, how to measure them without fooling yourself, and
what is left to take. Numbers are Chrome 157, KB per frame, 30 frames one
after another unless said otherwise (the kit's pages: a small ad frame, a
frame of 150 links, a frame that loads a 190 KB script by URL).

## Where the bytes go

- **The inject, per realm.** Each frame evaluates the document inject and
  runs its hooks in its own realm: about 1,075 KB of JS heap per frame
  (measure-frame-memory, 60 frames; frame-cost gates it, about 1,120 KB
  with its 20, which share the page's one-off costs less), where a native
  frame of the same page has its own script's heap only. It is the largest
  share for a small frame, and it is live, not garbage.
- **The markup, three times.** loadHTML parses the page's markup
  (DOMParser), copies it through the hooks into an inert document (the
  copy is where URLs are routed) and writes the copy's serialization, which
  the browser parses into the page. A frame of 150 links makes 2749 nodes
  where native makes 914: three trees of its markup, two of them garbage as
  soon as the write is done (markup-copy-nodes counts them with
  Memory.getDOMCounters). Natively, a parse and a copy made element by
  element through createElement and setAttribute, as the inject makes it,
  add about 300 KB of RSS and 57 KB of Oilpan heap to each frame of that
  markup; the copy alone is 50 to 200 KB of the RSS.
- **A handler attribute, about 3.5 KB.** A frame whose markup has one
  `onclick` costs about 3.5 KB more than the same frame without it
  (frame-cost gates the difference at 6 KB): the getters of the name
  (handlerGetters, about 2 KB) and the handler's map. The service worker
  rewrites the markup's handlers with its inline scripts and sends each
  place, where its start tag ends (src/prewrite.ts handlerSources), so the
  frame neither rewrites nor places one. Rewritten and placed in the page
  (a handler the worker could not read as the parser does, a page with no
  rewrite worker) it is about 11 KB: the rewrite's calls and the markup
  scan's code (src/inject/dom/markupPlaces.ts).
- **Links, a little more.** Each routed link carries the page's own value
  in a marker attribute (`s_o:href`) as well as the routed URL, in the
  copy and in the live page, and the link hook makes two attribute writes
  more per link: about 60 KB of Oilpan garbage per 150 links.
- **The workers, per load.** A body crosses from the transport's worker
  to the service worker with its chunks' buffers transferred, not copied.
  The service worker reads a script whole to digest and rewrite it, so a
  script load leaves two bodies of ArrayBuffers to the worker's collector
  (the chunks and the whole body), about 100 KB per frame in the
  renderer's ArrayBuffer partition for a 190 KB script. What the worker
  keeps (a rewrite's output for the same document's repeat, the memory
  cache's entries, the rewrite cache's) is held as Blobs, whose bytes the
  browser process keeps, not the renderer.

Before the worker fixes of 2026-11-17 the transport joined chunks into a
buffer of its own (one more body), the rewrite cache's key copied the body
again, the output was encoded into an ArrayBuffer kept 30 s and copied
into each Response, and the memory cache kept up to 96 MB of ArrayBuffers
in the worker: 250 KB per frame for the 190 KB script, against about 100
now.

## Measuring it: the worker-GC trap

- **An idle worker never collects.** V8 starts a major collection on
  external (ArrayBuffer) memory only after tens of MB of growth, and a
  worker that is not allocating runs none. So the workers' garbage stays
  in the frames' renderer as long as the page is quiet, and a measurement
  that forces a collection in the page alone misses it, while one that
  forces it in the workers hides it. Real users force nothing: measure
  both ways (the kit's GC_WORKERS: none, the service worker, the dedicated
  workers, all) and treat the no-collection numbers as the ones users get.
- **A worker's own figure lies about transfers.** Runtime.getHeapUsage's
  backingStorageSize counts a buffer the worker transferred away until a
  sweep finds it, so a worker that moves every body on still looks as if
  it held them. Read the renderer's partitions (memory-infra dumps, the
  array_buffer and buffer partitions) for what is really there, and the
  worker's uncollected figure only for what it makes.
- **Less ArrayBuffer garbage can mean more garbage of other kinds.** The
  ArrayBuffers a worker allocates are what prompt its collections; take
  them away and the collections come later, and garbage that holds other
  memory (Responses, Blink buffers) piles up meanwhile. Removing one copy
  in the service worker (the rewrite cache key's) made a frame of a
  memory-cached script 110 to 170 KB worse in the renderer until the
  copies that garbage held (the memory cache's Responses) were removed
  too. Releasing buffers early (`transfer(0)`) does the same. Judge a
  change by the renderer's total, without forced collections, never by
  the one figure it was meant to move.
- **Measure without the harness in the frames.** Playwright's
  `frame.evaluate` sets up what it evaluates with in that frame's realm,
  about 33 KB of heap a frame natively and through the proxy alike, and
  evaluates with a user gesture, which through the proxy reaches every
  proxied frame of the page (all are of one real origin), so frames the
  page appends then start with an activation no page load gives them,
  and a frame of another site hooks its gated calls at its start. Until
  2026-11-17 test/frame-memory.mjs polled every frame that way: its
  numbers held the 33 KB, and its frames of another site the hooks. It
  now evaluates with the DevTools protocol's Runtime.evaluate in each
  frame's main world, without a gesture, and measures frames a real click
  reached as cases of their own (`click`).
- **Prefer a deterministic count to a heap size.** Committed Oilpan and
  partition sizes swing by tens of KB per frame from run to run. A node
  count across one frame's load after a full collection
  (Memory.getDOMCounters), or a worker's uncollected ArrayBuffer growth
  across one load against the body's size, gives the same answer every
  run, and makes a test that fails before and passes after.

## Levers that are left

- **One tree for the markup pass.** Rewrite the DOMParser tree in place
  (set each attribute again through the hooks; its scripts are already
  marked started by the parser) and serialize that, instead of copying it
  into an inert document first. That is one tree of the markup fewer per
  frame (914 nodes for the 150-link frame). The hooks would then see each
  element in its tree with all its attributes present, where the copy
  shows them a detached element gaining attributes one by one, which
  changes what several of them read (the parsed `<base>` against the
  metas before it, an SVG animation's target, `srcset` against `sizes`, a
  script's type before its text), and template and noscript handling move
  with it. It needs a pass over the whole suite.
- **A table for the page's hrefs.** The routing itself cannot wait for
  first use: the browser uses `href` on its own (a click, a middle click,
  copy link address, prefetch, `:visited`). The marker attribute could go
  if the page's value survived the serialization another way, such as a
  table in the document client keyed by the routed URL, which the hooks
  read back instead of the attribute.
- **The floor of two bodies per script load.** The chunks and the whole
  body remain because the cache key digests the whole body and WebCrypto
  has no incremental digest. A digest computed as the chunks arrive (a JS
  SHA-256, or the transport's own) would let the service worker drop the
  chunks as it goes.
- **Lazy expiry of the repeat outputs.** Expired entries of the same
  document's repeat cache go only on the next store or lookup. They are
  Blobs, so what lingers is the browser process's memory, not the
  renderer's.

## With the site pool

With the site pool on (docs/site-pool.md, off by default) a frame of
another site than its page's is a slot's: its own origin, in a realm of
its slot's. Chrome 157 at the pool's last commit over b5f6bdaa, two runs
with the pool (one without, in brackets):

- measure-frame-memory (60 frames): a frame of the page's site 1,074.2 to
  1,074.4 KB (1,073.4); one of another site 1,083.3 to 1,083.5 KB
  (1,074.7), about 9 KB more, nearly all of it compiled code
  (InstructionStream, BytecodeArray) of the slot's realm (8.5 to 9 KB in
  heap snapshots of 20 frames); one of another site appended after a
  click in the top 1,083.8 KB (1,075.7), and one loading its next
  document after a click 1,086.2 KB (1,083.9).
- frame-cost (20 frames): 1,122.4 to 1,122.6 KB for the page's site
  (1,118.4), 1,128.4 to 1,129.0 KB for another site (1,120.1), and 1,133.7
  to 1,133.9 KB for another site's next document after a click (1,133.0).

Every figure is under the ceilings without the pool, so the pool has none
of its own. A frame of another site that loads its next document after a
click costs 2.8 KB more than one no click reached with the pool, against
9.2 KB more without it, where such a frame hooks its gated calls at its
start (src/inject/dom/activation.ts).

The figures for another site are taken once a first frame of it has
settled (frame-memory.mjs `warm`): that frame takes the pool's spare
agent and the hub starts the next one a moment later (SiteHub.warm),
which the suites would count, as they put every frame in one renderer.
They print it apart: 3,431 to 3,443 KB once, one agent started.

## Where to look

frame-cost and measure-frame-memory (the per-frame heap),
markup-copy-nodes (the three trees), worker-script-copies and large-body
(what the workers leave and keep), abandoned-bodies and paused-bodies (the
transport's memory for bodies nobody reads).
