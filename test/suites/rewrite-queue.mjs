// The order the rewrite workers take scripts in (src/server/rewriteQueue.ts),
// checked in node with a clock of its own: the parts of a split bundle
// first, then the largest first, ties in the order they came; and no script
// waits indefinitely. A small one queued while large ones keep arriving
// faster than a worker takes them is handed out within AGED_MS and one
// job, where largest-first alone would never reach it. Skips when esbuild
// is not installed, as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP rewrite-queue: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const bundle = `${OUT}rewrite-queue.mjs`;
await esbuild.build({
	entryPoints: [`${root}src/server/rewriteQueue.ts`],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { RewriteQueue, AGED_MS } = await import(`${bundle}?${Date.now()}`);

{
	let now = 0;
	const queue = new RewriteQueue(() => now);
	queue.add('small', 10, 1);
	queue.add('large', 1000, 1);
	queue.add('part', 5, 0);
	queue.add('large too', 1000, 1);
	const order = [];
	for (let job = queue.take(); job; job = queue.take()) order.push(job);
	ok(
		'a split bundle part first, then the largest, ties as they came',
		JSON.stringify(order) ===
			JSON.stringify(['part', 'large', 'large too', 'small']),
		JSON.stringify(order),
	);
}
{
	// one worker taking 300 ms a job, a large job arriving every 100 ms
	let now = 0;
	const queue = new RewriteQueue(() => now);
	queue.add('small', 10, 1);
	let next = 0;
	let tookSmallAt = null;
	let busyUntil = 0;
	for (now = 0; now <= 10000 && tookSmallAt === null; now += 10) {
		if (now >= next) {
			queue.add(`large ${now}`, 100000, 1);
			next += 100;
		}
		if (now >= busyUntil) {
			const job = queue.take();
			if (job === 'small') tookSmallAt = now;
			busyUntil = now + 300;
		}
	}
	ok(
		'a small script is handed out within AGED_MS and one job while large ones keep coming',
		tookSmallAt !== null && tookSmallAt <= AGED_MS + 300,
		`taken at ${tookSmallAt} ms (AGED_MS ${AGED_MS})`,
	);
}
{
	// aged jobs go oldest first, ahead of a younger split part
	let now = 0;
	const queue = new RewriteQueue(() => now);
	queue.add('old small', 1, 1);
	now = 500;
	queue.add('old large', 1000, 1);
	now = AGED_MS + 600;
	queue.add('part', 1, 0);
	const order = [queue.take(), queue.take(), queue.take()];
	ok(
		'jobs older than AGED_MS go first, oldest first',
		JSON.stringify(order) ===
			JSON.stringify(['old small', 'old large', 'part']),
		JSON.stringify(order),
	);
}
await done();
