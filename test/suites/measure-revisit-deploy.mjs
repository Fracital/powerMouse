// What a revisit costs after a deploy, before and after the rewrite cache is
// kept across a service-worker activation (src/server/rewriteCache.ts adopt,
// src/version.ts REWRITE_GENERATION). A measurement: the numbers depend on
// the machine and are left out of a gate run (measure-*).
//
// The rewrite cache is made under the rewriter's generation. A deploy that did
// not touch the rewriter keeps the same generation, so its entries survive the
// new worker's activation and a revisit is answered from them. Before this
// change every activation dropped the whole store, so the first visit after
// any deploy re-rewrote every script from scratch.
//
// This cannot bump the demo's own generation at runtime, so it reproduces the
// two activations on one build, over a heavy script (8 copies of three.js,
// about 4.9 MB in, more out):
//   cold       a first visit, nothing cached (the rewrite runs)
//   kept       a revisit whose store survived the activation (NEW: a hit)
//   dropped    a revisit whose store was cleared, as every activation did
//              before (clearCache stands in for the old activate: the rewrite
//              runs again)
// `dropped` is the old behaviour's revisit; `kept` is the new one's. Lower is
// better; the gap is the rewrite the revisit no longer pays.
//
//   RUNS  repeats of the interleaved trio (default 5)
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const RUNS = Number(process.env.RUNS) || 5;
const ROUTED = /\/stomp\/[\w-]+\/html\//;
// 8 copies of three.js, then a tiny tail script that marks the document: a
// classic script blocks the load event until it is fetched, rewritten and run
const QUERY = 'name=big&three=8';

const browser = await launch();
const page = await openDemo(browser, PROXY);

// a controller of its own on the demo's worker, as the rewrite-cache suite
// builds one, so clearCache() is reachable
await page.evaluate(async () => {
	const old = window.controller;
	document.querySelector('#revisit-frame')?.remove();
	const controller = new window.StompController({
		serviceworker: (await navigator.serviceWorker.getRegistration('/stomp/'))
			.active,
		transport: old.transport,
		directory: '/stomp/',
		codec: 'xor',
		cache: true,
	});
	await controller.wait();
	const element = document.createElement('iframe');
	element.id = 'revisit-frame';
	document.body.append(element);
	window.__frame = controller.createFrame(element);
	window.__controller = controller;
});

/** navigate the frame to the heavy page and time navigation to its load event */
async function timedLoad() {
	const url = `${FIXTURE}pages/rewrite-cache.html?s=${encodeURIComponent(QUERY)}`;
	const t0 = Date.now();
	await page.evaluate((u) => window.__frame.go(u), url);
	// the routed subframe reaches 'complete' only once the injected big script
	// (a classic script) has been fetched, rewritten and run
	for (let i = 0; i < 600; i++) {
		const ready = await page
			.frames()
			.findLast((frame) => ROUTED.test(frame.url()))
			?.evaluate(() => {
				const done = document.readyState === 'complete';
				const entry = performance
					.getEntriesByType('resource')
					.find((e) => e.name.includes('/rewrite-js') && e.responseEnd > 0);
				return done && !!entry;
			})
			.catch(() => false);
		if (ready) return Date.now() - t0;
		await sleep(50);
	}
	throw new Error('heavy page did not load');
}

const clearCache = () => page.evaluate(() => window.__controller.clearCache());

const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const cold = [];
const kept = [];
const dropped = [];
for (let run = 0; run < RUNS; run++) {
	// cold: nothing cached
	await clearCache();
	await sleep(150);
	cold.push(await timedLoad());
	// kept: the store survived the activation (the new behaviour), a warm hit
	kept.push(await timedLoad());
	// dropped: the store was cleared on activation (the old behaviour), re-rewrite
	await clearCache();
	await sleep(150);
	dropped.push(await timedLoad());
}

const list = (values) => values.map((v) => v.toFixed(0)).join(' / ');
const mCold = median(cold);
const mKept = median(kept);
const mDropped = median(dropped);
console.log(
	`cold  (first visit, re-rewrite):      ${list(cold)}  median ${mCold} ms`,
);
console.log(
	`dropped (revisit, OLD: store wiped):  ${list(dropped)}  median ${mDropped} ms`,
);
console.log(
	`kept    (revisit, NEW: store kept):   ${list(kept)}  median ${mKept} ms`,
);
console.log(
	`revisit after a (rewriter-unchanged) deploy: ${mDropped} ms -> ${mKept} ms (${(mDropped - mKept).toFixed(0)} ms / ${(100 - (mKept / mDropped) * 100).toFixed(0)}% faster)`,
);
console.log(
	'(host-load-affected absolutes; the relative gap is the point. Re-run on an idle host for publication numbers.)',
);

ok(
	'a kept revisit is faster than a dropped (old-behaviour) revisit',
	mKept < mDropped,
	`kept ${mKept} ms vs dropped ${mDropped} ms`,
);
ok(
	'a dropped revisit costs about what a cold first visit does',
	mDropped > mKept,
	`dropped ${mDropped} ms, cold ${mCold} ms, kept ${mKept} ms`,
);

await done(browser, page.errors);
