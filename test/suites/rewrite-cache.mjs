// The rewrite cache: a script's rewritten output is kept by everything it
// depends on, so the second load of the same script is answered from it,
// byte for byte what the rewrite made, while a change of any one part (the
// body, the URL, the script type, the config) is a miss. A response the
// HTTP cache may not keep (no-store, private) is never kept, a host with the
// cache off keeps nothing, and clearCache() empties it. The request log says
// which it was (`rewriteCache`: hit, miss or skip). The suite constructs its
// own controllers on the demo's service worker, as request-log does.
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);

// every routed script response's body, in order
const bodies = [];
page.context().on('response', async (response) => {
	if (!/\/js:\w+\//.test(response.url())) return;
	bodies.push(await response.text().catch(() => null));
});
/** the bodies seen of the script named `name` */
const bodiesOf = (name) =>
	bodies.filter(
		(body) => body?.match(/push\(\[\s*['"](\w+)['"]/)?.[1] === name,
	);

/** a controller of its own, logging to window.__log */
const controller = (options = {}) =>
	page.evaluate(async (options) => {
		const old = window.controller;
		window.__log = [];
		document.querySelector('#rewrite-cache-frame')?.remove();
		const controller = new window.StompController({
			serviceworker: (await navigator.serviceWorker.getRegistration('/stomp/'))
				.active,
			transport: old.transport,
			directory: '/stomp/',
			codec: 'xor',
			cache: true,
			onRequest: (info) => window.__log.push(info),
			...options,
		});
		await controller.wait();
		const element = document.createElement('iframe');
		element.id = 'rewrite-cache-frame';
		document.body.append(element);
		window.__frame = controller.createFrame(element);
		window.__controller = controller;
	}, options);

/**
 * Load the test page with one more script (`/rewrite-js?<query>`), and wait
 * for that script's log entry: its rewriteCache outcome
 */
async function load(query, { module = false } = {}) {
	const search = `s=${encodeURIComponent(query)}${module ? '&module' : ''}`;
	const before = await page.evaluate(() => window.__log.length);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/rewrite-cache.html?${search}`,
	);
	const target = `/rewrite-js?${query}`;
	for (let i = 0; i < 80; i++) {
		const entries = await page.evaluate(
			({ before, target }) =>
				window.__log.slice(before).filter((e) => e.url.endsWith(target)),
			{ before, target },
		);
		if (entries.length) {
			// a second fetch of the same script (the preload scanner's) lands
			// a moment later, if there is one
			await sleep(300);
			return entries[0].rewriteCache;
		}
		await sleep(100);
	}
	return 'none';
}

const bump = (name) => fetch(`${FIXTURE}rewrite-js/bump?name=${name}`);

await controller();
const first = await load('name=a');
const second = await load('name=a');
ok(
	'the first load of a script rewrites it and keeps the output',
	first === 'miss',
	first,
);
ok(
	'the second load of the same script is answered from the rewrite cache',
	second === 'hit',
	second,
);
{
	const seen = bodiesOf('a');
	ok(
		'the output from the cache is byte for byte what the rewrite made',
		seen.length === 2 && seen[0] === seen[1],
		JSON.stringify(seen.map((body) => body.length)),
	);
}

await bump('a');
ok('a changed body is a miss', (await load('name=a')) === 'miss');
ok(
	'the same body at another URL is a miss',
	(await load('name=a&other')) === 'miss',
);
ok(
	'the same script as a module is a miss',
	(await load('name=a', { module: true })) === 'miss',
);
ok(
	'and the module is a hit the second time',
	(await load('name=a', { module: true })) === 'hit',
);

for (const cc of ['no-store', 'private, max-age=60']) {
	const query = `name=b&cc=${encodeURIComponent(cc)}`;
	const outcomes = [await load(query), await load(query)];
	ok(
		`a script answered ${cc} is never kept`,
		outcomes.every((o) => o === 'skip'),
		outcomes.join(' '),
	);
}

// the parser-inserted script: Chrome's preload scanner may fetch it twice
{
	const parsed = await page.evaluate(() =>
		window.__log.filter((e) => e.url.endsWith('/rewrite-js?name=parsed')),
	);
	ok(
		'a parser-inserted script loaded again is a hit',
		parsed.length >= 2 &&
			parsed.slice(1).every((e) => e.rewriteCache === 'hit'),
		JSON.stringify(parsed.map((e) => e.rewriteCache)),
	);
}

// a config that differs: the same script misses under it
await controller({ allowInvalidJs: false });
ok(
	'the same script under another config is a miss',
	(await load('name=a')) === 'miss',
);
ok(
	'and a hit under that config the second time',
	(await load('name=a')) === 'hit',
);

// clearCache empties it
await page.evaluate(() => window.__controller.clearCache());
ok(
	'after clearCache() the script is rewritten again',
	(await load('name=a')) === 'miss',
);

// the cache off: nothing is kept (`skip`, never a hit)
await controller({ cache: false });
{
	const outcomes = [await load('name=c'), await load('name=c')];
	ok(
		'with cache: false a script is never kept',
		outcomes.every((o) => o === 'skip'),
		JSON.stringify(outcomes),
	);
}

await done(browser, page.errors);
