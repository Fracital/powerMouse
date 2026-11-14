// The rewrite cache: a script's rewritten output is kept by everything it
// depends on, so the second load of the same script is answered from it,
// byte for byte what the rewrite made, while a change of any one part (the
// body, the URL, the script type, the config) is a miss, but for the client's
// name, which a controller mints anew: a page script that never mentions it
// rewrites the same under any. A response the
// HTTP cache may not keep for privacy (no-store, private) is never kept, no-cache is,, a host with the
// cache off keeps nothing, and clearCache() empties it. A script loaded
// again comes straight from the store's entry for its URL, which is what
// lets Chrome keep its compiled code; the entry is one partition's (the
// site that loaded it): another site's page that loads the same script
// rewrites it for itself and is never given that entry, and nothing of the
// response it was made from (its Server-Timing) reaches a later load. The
// request log says
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
// every routed script response the browser got straight from a Cache API
// store, by the store's name (DevTools' cacheStorageCacheName): what Chrome
// keeps V8's code cache with
const fromStore = [];
const STORE = 'stomp-rewrite-cache';
{
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	cdp.on('Network.responseReceived', (event) => {
		if (/\/js:\w+\//.test(event.response.url))
			fromStore.push({
				url: event.response.url,
				store: event.response.cacheStorageCacheName ?? '',
			});
	});
}
/** the bodies seen of the script named `name` */
const bodiesOf = (name) =>
	bodies.filter(
		(body) => body?.match(/push\(\[\s*['"](\w+)['"]/)?.[1] === name,
	);

/** a controller of its own, logging to window.__log (the wasm module is the only rewriter) */
const controller = (options = {}) => construct(options);
const construct = (options) =>
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
async function load(
	query,
	{ module = false, tries = 80, site = FIXTURE, from = null } = {},
) {
	const search = `s=${encodeURIComponent(query)}${module ? '&module' : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}`;
	const before = await page.evaluate(() => window.__log.length);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${site}pages/rewrite-cache.html?${search}`,
	);
	const target = `/rewrite-js?${query}`;
	for (let i = 0; i < tries; i++) {
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
// the id this controller keeps (it was given none), and a script under it
const keptId = await page.evaluate(() => window.__controller.id);
await load('name=r');
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

// a script loaded again is answered with the rewrite cache's own entry,
// kept under the URL the page asked for: the response Chrome keeps the
// script's compiled code with (a response made from the entry's body gets
// none)
{
	const before = fromStore.length;
	const outcomes = [];
	for (let i = 0; i < 3; i++) outcomes.push(await load('name=s'));
	const stores = fromStore.slice(before).map((response) => response.store);
	const seen = bodiesOf('s');
	ok(
		"a script loaded again comes straight from the rewrite cache's entry for its URL, byte for byte",
		outcomes.join() === 'miss,hit,hit' &&
			stores.includes(STORE) &&
			seen.length === 3 &&
			seen.every((body) => body === seen[0]),
		JSON.stringify({ outcomes, stores, lengths: seen.map((b) => b?.length) }),
	);
}

// the entry is the partition's that loaded the script: a page of another
// site that loads the same script (the same routed URL) is not given it,
// nor spared the rewrite; it rewrites the script for itself and its output
// takes the URL's entry, while the first site's moves under its key and
// comes back from there without a rewrite
{
	const own = new URL(FIXTURE).origin;
	const other = FIXTURE.replace('127.0.0.1', 'localhost');
	const run = async (elsewhere) => {
		const before = fromStore.length;
		const outcome = await load(
			'name=p',
			elsewhere ? { site: other, from: own } : {},
		);
		return { outcome, seen: fromStore.slice(before) };
	};
	const runs = [];
	for (const elsewhere of [false, false, true, true, false, false])
		runs.push(await run(elsewhere));
	// the script's routed URL: the one the pages of both sites asked for
	const url = runs[0].seen
		.map((response) => response.url)
		.find((url) => runs[2].seen.some((response) => response.url === url));
	const stores = runs.map(({ seen }) =>
		seen.filter((response) => response.url === url).map(({ store }) => store),
	);
	const stored = (list) => list.length > 0 && list.includes(STORE);
	const made = (list) => list.length > 0 && !list.includes(STORE);
	ok(
		"another site's page that loads the same script is not given the first site's entry, and rewrites it for itself",
		runs.map(({ outcome }) => outcome).join() === 'miss,hit,miss,hit,hit,hit' &&
			made(stores[0]) &&
			stored(stores[1]) &&
			made(stores[2]) &&
			stored(stores[3]) &&
			made(stores[4]) &&
			stored(stores[5]),
		JSON.stringify({ outcomes: runs.map(({ outcome }) => outcome), stores }),
	);
}

// an entry carries nothing of the response it was made from that a browser
// does not act on: the Server-Timing a page reads from its resource timing
// is the first response's, and a later load is not given it as its own
{
	const metrics = async () => {
		const outcome = await load('name=t&st');
		const frame = page
			.frames()
			.findLast((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url()));
		const seen = await frame.evaluate(() =>
			performance
				.getEntriesByType('resource')
				.flatMap((entry) =>
					entry.serverTiming.map(
						(metric) => `${metric.name}=${metric.description}`,
					),
				),
		);
		return { outcome, seen };
	};
	const first = await metrics();
	const second = await metrics();
	ok(
		"a script from its entry does not bring the first response's Server-Timing",
		first.outcome === 'miss' &&
			first.seen.length === 1 &&
			first.seen[0].startsWith('nth=') &&
			second.outcome === 'hit' &&
			second.seen.length === 0,
		JSON.stringify({ first, second }),
	);
}

// a script whose output is over the 8 MB an entry could be (eight copies
// of three.js, 4.9 MB, whose text the output carries beside its code for
// its functions' sources: about 11 MB) is kept like any other
{
	const big = [
		await load('name=big&three=8', { tries: 600 }),
		await load('name=big&three=8', { tries: 600 }),
	];
	// (a body this large takes a moment to read)
	const large = () =>
		bodies.filter((body) => body && body.length > 8 * 1024 * 1024);
	for (let i = 0; i < 100 && large().length < 2; i++) await sleep(100);
	const seen = large();
	ok(
		'a script whose output is over 8 MB is kept, and served from the cache byte for byte',
		big[0] === 'miss' &&
			big[1] === 'hit' &&
			seen.length === 2 &&
			seen[0] === seen[1],
		JSON.stringify({ big, lengths: seen.map((body) => body.length) }),
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

// no-cache is not a privacy rule: the body arrives every time and the key
// is its digest, so the output is kept
{
	const query = 'name=d&cc=no-cache';
	const outcomes = [await load(query), await load(query)];
	ok(
		'a script answered no-cache is kept (the key is the body it just sent)',
		outcomes[0] === 'miss' && outcomes[1] === 'hit',
		outcomes.join(' '),
	);
}

// the parser-inserted script: Chrome's preload scanner may fetch it twice
// (the one of this site's pages: the other site's page has its own)
{
	const parsed = await page.evaluate(
		(url) => window.__log.filter((e) => e.url === url),
		`${FIXTURE}rewrite-js?name=parsed`,
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

// a controller that was given no id keeps its own: when the host page is
// loaded again, the controller in the same place among the page's has the
// address it had, and the outputs kept under it
await page.reload();
await page.waitForFunction(
	() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
	null,
	{ timeout: 45000 },
);
await controller();
ok(
	'a controller given no id has the id it had before the host page was loaded again',
	(await page.evaluate(() => window.__controller.id)) === keptId,
	JSON.stringify([keptId, await page.evaluate(() => window.__controller.id)]),
);
ok(
	'and a script kept under that address is a hit',
	(await load('name=r')) === 'hit',
);

// a host that keeps its controller's id across a reload (a new controller,
// the same address) gets the outputs it kept: the client's name is minted
// again, and a script that does not mention it rewrites the same
await controller({ id: 'rcKeep' });
ok(
	'a script under a kept id is a miss first',
	(await load('name=k')) === 'miss',
);
await controller({ id: 'rcKeep' });
ok(
	'and a hit for the next controller of the same id, whose client name differs',
	(await load('name=k')) === 'hit',
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

// What resource timing says of a load the entry answered. The entry is the
// same Response for every load, so the worker notes how each was delivered
// and tells the window (src/server/keptLoads.ts), which has the note when
// the page reads the entry, whether or not the worker still runs. Natively (Chrome 152 and
// 156; sop-escapes compares the first three in one page): the body and 300
// bytes, "" and the protocol from the network, also when the origin sends
// the same bytes again; 0, "cache" and the protocol from the renderer's
// memory cache; 0, "cache" and no protocol from the HTTP cache.
{
	await controller();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	const stopWorker = async () => {
		await sleep(300);
		await cdp.send('ServiceWorker.stopAllWorkers');
	};
	// (the controller gives up the navigation that finds its worker started
	// anew, and carries on with the next)
	const revive = async () => {
		for (let i = 0; i < 10; i++)
			try {
				await load('name=r');
				return;
			} catch {
				await sleep(300);
			}
	};
	const timing = async (query, { stop = false } = {}) => {
		const outcome = await load(query);
		if (stop) await stopWorker();
		const frame = page
			.frames()
			.findLast((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url()));
		const seen = await frame.evaluate((target) => {
			const entry = performance
				.getEntriesByType('resource')
				.findLast((entry) => entry.name.endsWith(target));
			return (
				entry && [
					entry.transferSize && entry.transferSize - entry.encodedBodySize,
					entry.deliveryType,
					entry.nextHopProtocol,
				]
			);
		}, `/rewrite-js?${query}`);
		return [outcome, ...(seen ?? ['no entry'])];
	};
	const NETWORK = ['', 'http/1.1'];
	const again = [
		await timing('name=tn'),
		await timing('name=tn'),
		await timing('name=tn', { stop: true }),
	];
	ok(
		'a script from its entry reads as a network load when the origin sent the same bytes again, also once the worker has stopped',
		same(again, [
			['miss', 300, ...NETWORK],
			['hit', 300, ...NETWORK],
			['hit', 300, ...NETWORK],
		]),
		JSON.stringify(again),
	);
	await revive();
	const fresh = [
		await timing('name=tf&cc=max-age%3D600'),
		await timing('name=tf&cc=max-age%3D600'),
	];
	await stopWorker();
	await revive();
	fresh.push(await timing('name=tf&cc=max-age%3D600'));
	ok(
		"and as the memory cache's, then the HTTP cache's, when the worker's caches answered",
		same(fresh, [
			['miss', 300, ...NETWORK],
			['hit', 0, 'cache', 'http/1.1'],
			['hit', 0, 'cache', ''],
		]),
		JSON.stringify(fresh),
	);
}

await done(browser, page.errors);
