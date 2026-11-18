// What every proxied frame pays, as a gate (measure-frame-memory is the
// measurement, and CI leaves measurements out). Each frame of a page
// evaluates the document inject and runs its hooks in its own realm, and
// ad-heavy pages keep hundreds of frames in one renderer, so a module that
// adds a little to each frame adds it hundreds of times. Six checks:
//
// - the size of dist/injectDocument.js, against a budget: 418 KB as built,
//   with the rewriter library a file of its own (dist/rewriterLib.js: the
//   bundle was 840 KB with meriyah, escodegen, css-tree, tldts and the
//   rewriters on them in it). A dependency the inject imports directly
//   instead of through the rewriter library (tldts did, +133 KB, every
//   frame evaluating its tables again), or a parser or the suffix list
//   coming back into the light library (css-tree and tldts were 205 KB of
//   it), goes past it. Deterministic. The document's light library left
//   the bundle too (41 KB: a frame uses its top's and evaluated none; it is
//   the rewriter library file's second statement): the bundle is 434 KB
//   with the membrane by origin, document identity, URL shapes and the
//   escape fixes. The budget was 460 KB, for the sealed URLs that came
//   next (about 3 KB); a page's Content-Security-Policy (its fetch, script
//   and style directives) took it to 456 KB, and its Trusted Types (every
//   sink the inject writes judging the page's value, the inject's own
//   writes carrying trusted values of its own policy) to 465 KB: the budget
//   is 468 KB. The Brave-parity anti-fingerprinting layer (the Fingerprint
//   module: per-site farbling of canvas, WebGL and audio readbacks and the
//   limiting of fonts, screen, hardware concurrency, device memory, media
//   devices and locale) added about 8 KB to the bundle (485 to 493 KB), so
//   the budget is 500 KB. The module is off by default and added to a frame
//   only when a surface is opted in, so it costs a default frame nothing at
//   run time; only the bundle (which carries every module's code) grows, and
//   the per-frame heap ceiling below is unchanged. The WebTransport
//   stand-in (docs/webtransport.md) added 7 KB (493.3 to 500.2 KB): a page
//   may call a session's members in the statement after it made it, so the
//   constructor's checks of its arguments and what a session answers while
//   it connects cannot be a file loaded when one is first made without a
//   synchronous request for it; a frame that makes none runs none of it
//   (one wrapper around the constructor, and the heap ceiling below is
//   unchanged). The budget went to 508 KB for it, and back to 500 KB once
//   the deferred parts (build.js DEFERRED_FILES) took the stand-in and other
//   code most frames never run out of the bundle (about 454 KB with the
//   stand-in deferred). The web-platform-tests fixes took it from 496.8 to
//   507.4 KB; a module's hook installer reading its client and the client's
//   global once, where each use read the property chain again, took it to
//   491.5 KB, and the fixes' parts a page reaches only by a rare call (a
//   beacon of an uncontrolled document, XMLHttpRequest's argument checks,
//   location.ancestorOrigins, NamedNodeMap's methods on an element's
//   attributes, a fresh context's referrer policy) and the sizing of an
//   IndexedDB record for navigator.storage.estimate() went to the deferred
//   parts (485.9 KB). The client hints' table made from its names, the
//   parts' shared table keyed by place and more rare paths in parts (an XML
//   document's load, the WebSocket stand-ins, the page's own CSP checks,
//   the HTML shell, window.open(), links and forms aimed at another
//   window, among others) took it to 448.8 KB, and the budget to 465 KB,
//   about the margin it had. Raise the budget in the same change as code
//   that has to grow the bundle, and say why; first see whether it can be
//   deferred.
// - the JS heap one proxied frame adds (test/frame-memory.mjs, FRAMES frames
//   of a small ad-like page, same site), against a ceiling above what this
//   build measures: 1,094 to 1,100 KB with 20 frames on Chrome 152 and 156
//   with the content blocker on in every frame, within a few KB from run to
//   run (1,147 to 1,153 KB before the SVG and CSS rule hooks named their
//   interfaces and one hook took every event handler attribute). The
//   ceiling, 1,150 KB, takes the escape fixes' hooks (about 24 KB a frame)
//   with about 25 KB to spare. A module that makes an interface every frame
//   (the WebGL ones, +90 KB; every SVG element interface, +33 KB) or
//   evaluates the rewriter library in every frame again (+230 KB) goes past
//   it. That is what the ceiling is for: a regression of a whole interface
//   or library in every frame, not the KB or two each fix costs. By the
//   time master measured 1,149 to 1,151 KB on CI, fixes of real escapes
//   were queueing on 1 to 3 KB a frame each, and the measure itself moves
//   by a KB or two between runs, so the ceiling went to 1,170 KB: the SVG
//   interfaces (+33 KB) still go past it from any master under about
//   1,137 KB. Each change's own cost is measured and stated in its message,
//   and kept down there (deferred parts, lazy installs, about 55 B a frame
//   for each function made at load). The deferred parts' split (each group
//   evaluated alone, the last check below) left these frames as they were:
//   they need no part.
// - the same for FRAMES frames of another site (localhost), against a
//   ceiling of its own. A frame of another site than its page's is not one
//   of the page's site: the membrane hands it stand-ins, and a hook may run
//   only there (a regression of 26 KB a frame in such frames went past the
//   same-site check and CI). 1,152 KB with 20 frames on Chrome 157 at
//   5bdd2289, two runs: the first frame of a site pays its site's one-off
//   cost, which 20 frames share (with 10 it reads 1,213 to 1,217 KB, with
//   60 in measure-frame-memory about 1,102). The ceiling, 1,172 KB, keeps
//   the same-site one's margin: one interface made in every such frame (the
//   SVG element interfaces, +33 KB) goes past it, and so does that 26 KB.
// - the same for FRAMES frames of another site that read their parent and
//   top and post to their parent as they start, as an ad frame does
//   (test/pages/frame-memory-parent.html). With the site pool those are a
//   read of and a post to a window of another slot (siteWindows'
//   restrictAcross and postAcross), which must need no deferred part: 1,124
//   KB without the pool and 1,140 to 1,141 KB with it (STOMP_SITE_POOL=5)
//   on Chrome 157 at the commit that put them back in the bundle, 1,142 to
//   1,143 KB with them a part (40 frames, three runs each: 1,103.7 to
//   1,104.9 KB against 1,106.9 to 1,107.6, the plain frames of another site
//   1,094.0 to 1,095.9). The ceiling is 1,136 KB without the pool, 1,150 KB
//   with it (about 9 KB over): the run-to-run noise at 20 frames is about
//   that part's 3 KB, so site-pool-refusals holds that such a frame needs
//   no part; the ceiling holds an interface or the whole parts statement
//   made in every such frame.
// - the same for FRAMES frames of another site that load their next
//   document right after a real click in the top (test/frame-memory.mjs
//   `click: 'refresh'`), as an ad frame loads its next ad: through the
//   proxy the click reaches every frame, and one of another site starts
//   with an activation only the proxy gave it, so it hooks its gated calls
//   at its start (src/inject/dom/activation.ts). This is where that 26 KB
//   was (the gates' statement evaluated in each such frame): 1,151.7 to
//   1,151.8 KB at 460d3f07, 1,126.2 to 1,126.5 KB before the gates, and
//   1,133.8 KB (two runs) with the statement the proxied top evaluates
//   once. The ceiling, 1,149 KB, keeps the others' margin (about 15 KB):
//   that regression and an interface in every frame go past it.
// - the same for FRAMES frames of the page's site that open a first
//   XMLHttpRequest (test/pages/frame-memory-xhr.html), which makes the
//   document's first deferred part (XHR's argument checks): an ad frame's
//   first request, a write, a WebSocket or a postMessage across slots each
//   needs one. The deferred parts are one statement with a case for each
//   group of them (build.js partsStatement), and a frame runs only the
//   group it needs: 1,132.2 to 1,133.7 KB with 20 frames on Chrome 157 at
//   aa07538e with the split, 1,167.5 to 1,169.0 KB before it, when a frame
//   evaluated every part at its first need of one (1,119.5 to 1,121.5 KB
//   for the plain frames, the same with and without). Making the whole
//   statement's function was still some 11 KB of the frame (about 8 to
//   make it, 3 to call it), though it ran one group: a frame evaluates the
//   group it needs alone (src/inject/rewriter.ts partGroup), 1,121.0 to 1,121.5 KB
//   at 7dd1b6d7 with it, 1,131.3 to 1,133.4 KB without (1,118.3 to
//   1,120.2 KB for the plain frames). The ceiling, 1,130 KB, is about 9 KB
//   over that: the whole statement made in such a frame again (+11 KB)
//   goes past it.
//
// None of these evaluates with a user gesture or with Playwright in the
// frames (test/frame-memory.mjs says why). Until 2026-11-17 the fixture
// did both: every number above until then held about 36 KB a frame of
// Playwright's (20 frames: 1,155.3 KB same site and 1,157.6 KB another
// site then, 1,118.9 and 1,120.9 KB without, at the same build, Chrome
// 157), so the two ceilings above came down by as much, to 1,134 KB and
// 1,136 KB, keeping their margins: the SVG element interfaces (+33 KB) go
// past both.
//
// On 2026-11-18 a frame's heap came down by about 28 KB in every case:
// the native prototype copies leave out the event handlers (about 20 KB)
// and the bundle's own navigator has only the members it reads (about 8).
// 20 frames on Chrome 157, two runs each, at eed90e1d and with both:
// 1,121.0 to 1,121.1 KB and 1,092.1 to 1,092.8 same site, 1,119.1 to
// 1,121.2 and 1,093.6 to 1,094.9 another site, 1,125.3 to 1,126.6 and
// 1,097.7 to 1,098.9 reading the parent, 1,132.5 to 1,133.5 and 1,104.4
// to 1,105.3 after a click, 1,122.5 to 1,123.3 and 1,092.7 to 1,094.9
// with a first XMLHttpRequest. Every ceiling came down by as much (the
// parent-reading frames' with the pool too), keeping its margin.
import { statSync } from 'node:fs';
import { measureFrames } from '../frame-memory.mjs';
import { done, FIXTURE, ok, SLOT_PORTS } from '../lib.mjs';

const BUNDLE = new URL('../../dist/injectDocument.js', import.meta.url);
const BUNDLE_BUDGET_KB = Number(process.env.INJECT_BUDGET_KB) || 465;
const FRAMES = Number(process.env.FRAMES) || 20;
const HEAP_LIMIT_KB = Number(process.env.FRAME_HEAP_LIMIT_KB) || 1106;
const OTHER_LIMIT_KB = Number(process.env.FRAME_HEAP_OTHER_LIMIT_KB) || 1108;
const CLICK_LIMIT_KB = Number(process.env.FRAME_HEAP_CLICK_LIMIT_KB) || 1121;
const PART_LIMIT_KB = Number(process.env.FRAME_HEAP_PART_LIMIT_KB) || 1102;
// With the site pool on (STOMP_SITE_POOL) a frame of another site is a
// slot's: its first one takes the pool's spare and the hub starts the next,
// about 3.4 MB once, which 20 frames would read as 170 KB each, so the
// frames of another site are measured after a first one settled (`warm`).
// The ceilings are the same (docs/frame-memory.md, "With the site pool"),
// but for the frames that read their parent and post to it: with the pool
// those are reads of and posts to a window of another slot, which make the
// stand-in every document of the frame's origin shares for it.
const POOL = SLOT_PORTS.length > 0;
const PARENT_LIMIT_KB =
	Number(process.env.FRAME_HEAP_PARENT_LIMIT_KB) || (POOL ? 1122 : 1108);

const bundleKB = statSync(BUNDLE).size / 1024;
ok(
	`dist/injectDocument.js is at most ${BUNDLE_BUDGET_KB} KB`,
	bundleKB <= BUNDLE_BUDGET_KB,
	`${bundleKB.toFixed(0)} KB`,
);

const result = await measureFrames({ proxied: true, frames: FRAMES });
ok(
	`all ${FRAMES} proxied frames ran their script`,
	result.loaded === FRAMES,
	`${result.loaded} did`,
);
ok(
	`a proxied frame costs at most ${HEAP_LIMIT_KB} KB of heap`,
	result.heapKB <= HEAP_LIMIT_KB,
	`${result.heapKB.toFixed(0)} KB, ${result.rssKB.toFixed(0)} KB RSS, ${(result.scriptMs / FRAMES).toFixed(1)} ms of script (${FRAMES} frames)`,
);

const otherSite = `http://localhost:${new URL(FIXTURE).port}/`;
const other = await measureFrames({
	proxied: true,
	base: otherSite,
	frames: FRAMES,
	warm: POOL,
});
ok(
	`all ${FRAMES} proxied frames of another site ran their script`,
	other.loaded === FRAMES,
	`${other.loaded} did`,
);
ok(
	`a proxied frame of another site costs at most ${OTHER_LIMIT_KB} KB of heap`,
	other.heapKB <= OTHER_LIMIT_KB,
	`${other.heapKB.toFixed(0)} KB, ${other.rssKB.toFixed(0)} KB RSS, ${(other.scriptMs / FRAMES).toFixed(1)} ms of script (${FRAMES} frames)`,
);

const reading = await measureFrames({
	proxied: true,
	base: otherSite,
	frames: FRAMES,
	warm: POOL,
	child: 'pages/frame-memory-parent.html',
});
ok(
	`all ${FRAMES} proxied frames of another site that read their parent and post to it ran their script`,
	reading.loaded === FRAMES,
	`${reading.loaded} did`,
);
ok(
	`a proxied frame of another site that reads its parent and top and posts to its parent costs at most ${PARENT_LIMIT_KB} KB of heap`,
	reading.heapKB <= PARENT_LIMIT_KB,
	`${reading.heapKB.toFixed(0)} KB, ${reading.rssKB.toFixed(0)} KB RSS (${FRAMES} frames)`,
);

const clicked = await measureFrames({
	proxied: true,
	base: otherSite,
	frames: FRAMES,
	click: 'refresh',
	warm: POOL,
});
ok(
	`all ${FRAMES} proxied frames of another site loaded their next document after a click`,
	clicked.loaded === FRAMES,
	`${clicked.loaded} did`,
);
ok(
	`a proxied frame of another site that loads its next document right after a click costs at most ${CLICK_LIMIT_KB} KB of heap`,
	clicked.heapKB <= CLICK_LIMIT_KB,
	`${clicked.heapKB.toFixed(0)} KB, ${clicked.rssKB.toFixed(0)} KB RSS (${FRAMES} frames)`,
);

const parted = await measureFrames({
	proxied: true,
	frames: FRAMES,
	child: 'pages/frame-memory-xhr.html',
});
ok(
	`all ${FRAMES} proxied frames that open an XMLHttpRequest ran their script`,
	parted.loaded === FRAMES,
	`${parted.loaded} did`,
);
ok(
	`a proxied frame that opens an XMLHttpRequest (a deferred part's first need) costs at most ${PART_LIMIT_KB} KB of heap`,
	parted.heapKB <= PART_LIMIT_KB,
	`${parted.heapKB.toFixed(0)} KB, ${parted.rssKB.toFixed(0)} KB RSS (${FRAMES} frames)`,
);
await done(null);
