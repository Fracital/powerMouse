// What every proxied frame pays, as a gate (measure-frame-memory is the
// measurement, and CI leaves measurements out). Each frame of a page
// evaluates the document inject and runs its hooks in its own realm, and
// ad-heavy pages keep hundreds of frames in one renderer, so a module that
// adds a little to each frame adds it hundreds of times. Two checks:
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
//   escape fixes. The budget, 460 KB, holds the sealed URLs that come next
//   (about 3 KB). Raise it in the same change as code that has to grow the
//   bundle, and say why.
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
//   it.
import { statSync } from 'node:fs';
import { measureFrames } from '../frame-memory.mjs';
import { done, ok } from '../lib.mjs';

const BUNDLE = new URL('../../dist/injectDocument.js', import.meta.url);
const BUNDLE_BUDGET_KB = Number(process.env.INJECT_BUDGET_KB) || 460;
const FRAMES = Number(process.env.FRAMES) || 20;
const HEAP_LIMIT_KB = Number(process.env.FRAME_HEAP_LIMIT_KB) || 1150;

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
	`${result.heapKB.toFixed(0)} KB, ${result.rssKB.toFixed(0)} KB RSS (${FRAMES} frames)`,
);
await done(null);
