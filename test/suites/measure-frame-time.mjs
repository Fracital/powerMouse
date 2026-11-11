// Measurement: the time FRAMES proxied frames take (test/frame-memory.mjs):
// from the page appending them to the last one's inline script having run,
// and the script and task time the renderer's main thread spent on them.
// Every frame evaluates the document inject and runs its hooks before its
// page's first script, so what the bundle carries is paid here per frame.
// RUNS browsers, one after another; SKIP_MEASUREMENT=1 leaves the suite out.
import { measureFrames } from '../frame-memory.mjs';
import { done, ok } from '../lib.mjs';

const FRAMES = Number(process.env.FRAMES) || 20;
const RUNS = Number(process.env.RUNS) || 3;

const rows = [];
for (let run = 0; run < RUNS; run++) {
	const result = await measureFrames({ proxied: true, frames: FRAMES });
	rows.push(result);
	ok(
		`run ${run + 1}: all ${FRAMES} frames ran their script`,
		result.loaded === FRAMES,
		`${result.loaded} did`,
	);
}
const list = (key) => rows.map((row) => row[key].toFixed(0)).join(' / ');
console.log(`\n${FRAMES} proxied frames, ${RUNS} runs`);
console.log(`  wall ms         ${list('wallMs')}`);
console.log(`  script ms       ${list('scriptMs')}`);
console.log(`  task ms         ${list('taskMs')}`);
console.log(`  heap KB/frame   ${list('heapKB')}`);
console.log('');
await done(null);
