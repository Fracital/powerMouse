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
  runs its hooks in its own realm: about 1150 KB of JS heap per frame
  (frame-cost gates it, measure-frame-memory measures it), where a native
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

## Where to look

frame-cost and measure-frame-memory (the per-frame heap),
markup-copy-nodes (the three trees), worker-script-copies and large-body
(what the workers leave and keep), abandoned-bodies and paused-bodies (the
transport's memory for bodies nobody reads).
