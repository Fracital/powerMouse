// Measurement: what a live frame costs, natively and through the proxy
// (test/frame-memory.mjs): FRAMES frames of a small page like a cookie-sync
// or ad frame, the JS heap after GC and the renderers' RSS before and after.
// Same-origin mode puts every proxied frame in the host's renderer, so a
// page with hundreds of such frames (imgur keeps about a thousand) pays this
// hundreds of times. Also printed: the median time from a frame's time
// origin to its inline script running (a proxied frame rewrites the script
// first), and how long all of them took to load. Children of the page's own
// site and of another site (localhost) are measured separately.
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
// lighter form of this check in CI
const HEAP_LIMIT_KB = Number(process.env.FRAME_HEAP_LIMIT_KB) || 1100;
const fixture = new URL(FIXTURE);
const otherSite = `http://localhost:${fixture.port}/`;

const rows = [];
for (const [name, proxied, base] of [
	['native', false, FIXTURE],
	['proxied', true, FIXTURE],
	['proxied, other site', true, otherSite],
]) {
	const result = await measureFrames({ proxied, base, frames: FRAMES });
	rows.push([name, result]);
	ok(
		`${name}: all ${FRAMES} frames ran their script`,
		result.loaded === FRAMES,
		`${result.loaded} did`,
	);
}
console.log(
	`\nper frame, ${FRAMES} frames    heap KB   RSS KB   script at ms   all loaded ms`,
);
for (const [name, r] of rows)
	console.log(
		`  ${name.padEnd(22)} ${r.heapKB.toFixed(0).padStart(7)} ${r.rssKB.toFixed(0).padStart(8)} ${r.scriptAt.toFixed(0).padStart(14)} ${String(r.loadMs).padStart(15)}`,
	);
console.log('');
for (const [name, r] of rows.slice(1))
	ok(
		`${name}: a frame costs at most ${HEAP_LIMIT_KB} KB of heap`,
		r.heapKB <= HEAP_LIMIT_KB,
		`${r.heapKB.toFixed(0)} KB`,
	);
await done(null);
