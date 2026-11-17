// What every proxied frame pays, as a gate (measure-frame-memory is the
// measurement, and CI leaves measurements out). Each frame of a page
// evaluates the document inject and runs its hooks in its own realm, and
// ad-heavy pages keep hundreds of frames in one renderer, so a module that
// adds a little to each frame adds it hundreds of times. Three checks:
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
//   parts (485.9 KB). Raise the budget in the same change as code
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
//   for each function made at load); when the deferred parts are split so
//   each is evaluated alone, the ceiling comes back down.
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
import { statSync } from 'node:fs';
import { measureFrames } from '../frame-memory.mjs';
import { done, FIXTURE, ok } from '../lib.mjs';

const BUNDLE = new URL('../../dist/injectDocument.js', import.meta.url);
const BUNDLE_BUDGET_KB = Number(process.env.INJECT_BUDGET_KB) || 500;
const FRAMES = Number(process.env.FRAMES) || 20;
const HEAP_LIMIT_KB = Number(process.env.FRAME_HEAP_LIMIT_KB) || 1170;
const OTHER_LIMIT_KB = Number(process.env.FRAME_HEAP_OTHER_LIMIT_KB) || 1172;

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

const other = await measureFrames({
	proxied: true,
	base: `http://localhost:${new URL(FIXTURE).port}/`,
	frames: FRAMES,
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
await done(null);
