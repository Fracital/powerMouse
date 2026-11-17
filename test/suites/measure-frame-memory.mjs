// Measurement: what a live frame costs, natively and through the proxy
// (test/frame-memory.mjs): FRAMES frames of a small page like a cookie-sync
// or ad frame, the JS heap after GC and the renderers' RSS before and after.
// Same-origin mode puts every proxied frame in the host's renderer, so a
// page with hundreds of such frames (imgur keeps about a thousand) pays this
// hundreds of times. Also printed: the median time from a frame's time
// origin to its inline script running (a proxied frame rewrites the script
// first), and how long all of them took to load. Children of the page's own
// site and of another site (localhost) are measured separately, and so
// are frames a real click in the top reached (test/frame-memory.mjs
// `click`): appended right after it, and loading their next document right
// after it, as an ad frame loads its next ad. Through the proxy the click
// reaches every frame; one of another site then hooks its gesture-gated
// calls (src/inject/dom/activation.ts). Nothing evaluates with a user
// gesture: a frame the page appends starts with no activation, as on a
// page load.
// SKIP_MEASUREMENT=1 leaves the suite out.
//
// Per frame, 60 frames, same-site children, this machine (Chrome 152):
//
//                      heap KB   RSS KB
//   native                 400     1140
//   8efa41b               1834     3629
//   no ast-types          1379     3109
//   crypto-js parts       1276     3023
//   shared rewriter       1048     2299
//   50fda7c               1219     2822
//   lazy WebGL hooks,
//   shaped wrappers       1015     2481
import { measureFrames } from '../frame-memory.mjs';
import { done, FIXTURE, ok } from '../lib.mjs';

const FRAMES = Number(process.env.FRAMES) || 60;
// a ceiling above what this build measures (1,015 KB) that a frame which
// evaluates the rewriter library again (about +230 KB), ast-types (+450 KB)
// or makes the WebGL interfaces (+90 KB) goes past. frame-cost keeps a
// lighter form of this check in CI. 1,120 KB since master measured 1,100 to
// 1,101 KB for a frame of the same site with the escape fixes of 2026-11
// (frame-cost's comment says why the ceilings went up, and when they come
// back down). Those numbers held about 33 KB a frame of Playwright's own
// (test/frame-memory.mjs polled each frame with its evaluate, natively
// too: 398.6 KB native then, 365.1 KB now): without it a frame reads 1,074
// KB (same site) and 1,076 KB (another site) on Chrome 157, so the ceiling
// is 1,095 KB, the same margin. A frame a click reached has a ceiling of
// its own, the same margin over its 1,081 KB (same site) and 1,085 KB
// (another site, hooked at its start): 1,105 KB.
const HEAP_LIMIT_KB = Number(process.env.FRAME_HEAP_LIMIT_KB) || 1095;
const CLICK_LIMIT_KB = Number(process.env.FRAME_HEAP_CLICK_LIMIT_KB) || 1105;
const fixture = new URL(FIXTURE);
const otherSite = `http://localhost:${fixture.port}/`;

const rows = [];
for (const [name, proxied, base, click = null] of [
	['native', false, FIXTURE],
	['proxied', true, FIXTURE],
	['proxied, other site', true, otherSite],
	['proxied, after a click', true, FIXTURE, 'before'],
	['proxied, other site, after a click', true, otherSite, 'before'],
	['proxied, next document after a click', true, FIXTURE, 'refresh'],
	[
		'proxied, other site, next document after a click',
		true,
		otherSite,
		'refresh',
	],
]) {
	const result = await measureFrames({ proxied, base, frames: FRAMES, click });
	rows.push([name, result, click ? CLICK_LIMIT_KB : HEAP_LIMIT_KB]);
	ok(
		`${name}: all ${FRAMES} frames ran their script`,
		result.loaded === FRAMES,
		`${result.loaded} did`,
	);
}
console.log(
	`\nper frame, ${FRAMES} frames${' '.repeat(28)}heap KB   RSS KB   script at ms   all loaded ms`,
);
for (const [name, r] of rows)
	console.log(
		`  ${name.padEnd(48)} ${r.heapKB.toFixed(0).padStart(7)} ${r.rssKB.toFixed(0).padStart(8)} ${r.scriptAt.toFixed(0).padStart(14)} ${String(r.loadMs).padStart(15)}`,
	);
console.log('');
for (const [name, r, limit] of rows.slice(1))
	ok(
		`${name}: a frame costs at most ${limit} KB of heap`,
		r.heapKB <= limit,
		`${r.heapKB.toFixed(0)} KB`,
	);
await done(null);
