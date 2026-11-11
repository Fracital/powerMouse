// The rewrite pool: the controller's rewrite workers rewrite scripts for
// the service worker, which falls back to rewriting itself whenever no
// worker answers: none started, the workers failed to load or never said
// they were ready (at once, no wait), or one did not answer within the
// timeout (then it is not asked again). The output is
// byte for byte the service worker's own. The request log says where
// (`rewriteIn`). The rewrite cache is off, so every load is rewritten.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	REWRITER,
	sleep,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
// the run's rewriter backend (STOMP_REWRITER), for every controller made here
await page.evaluate((rewriter) => (window.__rewriter = rewriter), REWRITER);

// every routed script response's body, in order
const bodies = [];
page.context().on('response', async (response) => {
	if (!/\/js:\w+\//.test(response.url())) return;
	bodies.push(await response.text().catch(() => null));
});
const bodiesOf = (name) =>
	bodies.filter(
		(body) => body?.match(/push\(\[\s*['"](\w+)['"]/)?.[1] === name,
	);

/** a controller of its own, logging to window.__log */
const controller = (options = {}) =>
	page.evaluate(async (options) => {
		const old = window.controller;
		window.__log = [];
		document.querySelector('#rewrite-pool-frame')?.remove();
		const controller = new window.StompController({
			serviceworker: (await navigator.serviceWorker.getRegistration('/stomp/'))
				.active,
			transport: old.transport,
			directory: '/stomp/',
			codec: 'xor',
			cache: false,
			// one address throughout: the output names it
			id: 'rewrite-pool',
			onRequest: (info) => window.__log.push(info),
			...window.__rewriter,
			...options,
		});
		await controller.wait();
		const element = document.createElement('iframe');
		element.id = 'rewrite-pool-frame';
		document.body.append(element);
		window.__frame = controller.createFrame(element);
	}, options);

/** load the test page with `/rewrite-js?<query>`: where it was rewritten, whether it ran, how long it took */
async function load(query) {
	const started = Date.now();
	const before = await page.evaluate(() => window.__log.length);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/rewrite-cache.html?s=${encodeURIComponent(query)}`,
	);
	const target = `/rewrite-js?${query}`;
	for (let i = 0; i < 300; i++) {
		const entry = await page.evaluate(
			({ before, target }) =>
				window.__log.slice(before).find((e) => e.url.endsWith(target)),
			{ before, target },
		);
		if (entry) {
			const name = new URLSearchParams(query).get('name');
			let ran = false;
			for (let j = 0; j < 40 && !ran; j++) {
				ran = await page
					.evaluate(
						(name) =>
							!!window.__frame.element.contentWindow.__rc?.some(
								([n]) => n === name,
							),
						name,
					)
					.catch(() => false);
				if (!ran) await sleep(50);
			}
			return {
				where: entry.rewriteIn,
				ran,
				ms: Date.now() - started,
			};
		}
		await sleep(50);
	}
	return { where: 'none', ran: false, ms: Date.now() - started };
}

const show = (result) => JSON.stringify(result);

// a pool, and the same script rewritten by it and by the service worker
await controller({ rewriteWorkers: 2 });
{
	const pooled = await load('name=a');
	ok(
		"a script is rewritten in one of the controller's workers, and runs",
		pooled.where === 'pool' && pooled.ran,
		show(pooled),
	);
}
await controller({ rewriteWorkers: 0 });
{
	const own = await load('name=a');
	ok(
		'a controller that started no worker: the service worker rewrites it, and it runs',
		own.where === 'service-worker' && own.ran,
		show(own),
	);
	const seen = bodiesOf('a');
	ok(
		"the pool's output is byte for byte the service worker's",
		seen.length === 2 && seen[0] !== null && seen[0] === seen[1],
		// the bodies themselves when they differ, to see where
		seen[0] === seen[1]
			? JSON.stringify(seen.map((body) => body?.length))
			: JSON.stringify(seen),
	);
}

// a module script goes to the pool too
await controller({ rewriteWorkers: 1 });
{
	const result = await page.evaluate(async (fixture) => {
		const before = window.__log.length;
		await window.__frame.go(
			`${fixture}pages/rewrite-cache.html?s=${encodeURIComponent('name=m')}&module`,
		);
		for (let i = 0; i < 200; i++) {
			const entry = window.__log
				.slice(before)
				.find((e) => e.url.endsWith('/rewrite-js?name=m'));
			if (entry) return entry.rewriteIn;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return 'none';
	}, FIXTURE);
	ok('a module script is rewritten in the pool', result === 'pool', result);
}

// workers that cannot load (a name nothing serves): never ready, so the
// service worker rewrites at once, never waiting on them
await controller({
	rewriteWorkers: 2,
	assets: { rewriteWorker: 'no-such-rewrite-worker.js' },
});
{
	const first = await load('name=b');
	const second = await load('name=b&again');
	ok(
		'workers that failed to load: the service worker rewrites at once',
		[first, second].every(
			(r) => r.where === 'service-worker' && r.ran && r.ms < 2500,
		),
		show([first, second]),
	);
}

// a worker script that is not a rewrite worker: never ready, the same
await controller({
	rewriteWorkers: 1,
	assets: { rewriteWorker: 'transportWorker.js' },
});
{
	const first = await load('name=c');
	ok(
		'a worker that never says it is ready: the service worker rewrites at once',
		first.where === 'service-worker' && first.ran && first.ms < 2500,
		show(first),
	);
}

// a ready worker that takes longer than the timeout: the service worker
// rewrites that script itself, and does not send that worker another
await controller({ rewriteWorkers: 1, rewriteTimeout: 150 });
{
	const small = await load('name=e');
	// (the wasm rewriter takes three copies of three.js well inside the
	// timeout: in its run the script opens with a shape it leaves to the
	// JavaScript rewriter, a pattern key that is a BigInt beside `top`)
	const slow = await load(
		`name=e&three=3${REWRITER.rewriter ? `&extra=${encodeURIComponent('var { 1n: one, top: mine } = { top: 0 };')}` : ''}`,
	);
	const after = await load('name=e&after');
	ok(
		'a ready worker answers first',
		small.where === 'pool' && small.ran,
		show(small),
	);
	ok(
		'a rewrite past the timeout is made by the service worker, and runs',
		slow.where === 'service-worker' && slow.ran,
		show(slow),
	);
	ok(
		'and that worker is not sent another',
		after.where === 'service-worker' && after.ran,
		show(after),
	);
}

await done(browser, page.errors);
