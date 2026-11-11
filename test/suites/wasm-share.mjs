// `rewriter: 'wasm'`: the controller loads the wasm modules once and every
// thread that rewrites holds them (src/wasm/thread.ts). The rewrite workers
// get the compiled modules; the service worker gets their bytes with the
// handshake, because a message holding a WebAssembly.Module never reaches a
// service worker (it is an agent cluster of its own) and a handshake that
// carried one left the controller waiting for the worker forever. A proxied
// top asks its controller for the compiled module (they are one agent
// cluster) for the rewriter library it shares with its frames, so a frame
// holds no instance. A page loads and runs as before either way: a module
// only ever answers what the JavaScript rewriter would have. A stylesheet's
// request says the scanner module rewrote it (`rewriteBy`), and its url() is
// routed as before. The service worker names the public suffix list its
// sites are answered from once it holds the suffix module
// (rust/suffix/src/pins.env), and none while tldts answers.
import { readFileSync } from 'node:fs';
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);

/**
 * A controller of its own, at an address of its own (the worker's startup
 * broadcast makes a controller that was replaced shake hands again, which
 * would replace the one under test). False when its handshake never
 * completed.
 */
const controller = (id, options = {}) =>
	page.evaluate(
		async ({ id, options }) => {
			const old = window.controller;
			window.__log = [];
			document.querySelector('#wasm-share-frame')?.remove();
			const controller = new window.StompController({
				serviceworker: (
					await navigator.serviceWorker.getRegistration('/stomp/')
				).active,
				transport: old.transport,
				directory: '/stomp/',
				codec: 'xor',
				cache: false,
				id,
				onRequest: (info) => window.__log.push(info),
				...options,
			});
			const ready = await Promise.race([
				controller.wait().then(() => true),
				new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
			]);
			window.__controller = controller;
			if (!ready) return false;
			const element = document.createElement('iframe');
			element.id = 'wasm-share-frame';
			document.body.append(element);
			window.__frame = controller.createFrame(element);
			return true;
		},
		{ id, options },
	);

/** the modules each thread holds, once `settled` says they are all in */
async function held(settled) {
	let last;
	for (let i = 0; i < 100; i++) {
		last = await page.evaluate(() => window.__controller.wasmModules());
		if (settled(last)) break;
		await sleep(100);
	}
	return last;
}

/** every module of the build: the JS rewriter, the CSS and markup scanner and the public suffix list */
const MODULES = ['rewriter', 'scanner', 'suffix'];
const holdsAll = (names) => MODULES.every((name) => names.includes(name));

/** load the fixture page with a stylesheet of one url(): how the sheet was scanned and whether its image was fetched */
async function loadStyled() {
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/reqlog.html`,
	);
	let result;
	for (let i = 0; i < 300; i++) {
		result = await page.evaluate(() => {
			const sheet = window.__log.find((e) => e.url.endsWith('/reqlog.css'));
			const image = window.__log.find((e) => e.url.endsWith('/sprite.svg'));
			return {
				sheet: sheet?.status,
				by: sheet?.rewriteBy,
				image: image?.status,
				destination: image?.destination,
			};
		});
		if (result.sheet && result.image) break;
		await sleep(50);
	}
	return result;
}

/** load the fixture page whose script pushes `name`: where it was rewritten and whether it ran */
async function load(name) {
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/rewrite-cache.html?s=${encodeURIComponent(`name=${name}`)}`,
	);
	for (let i = 0; i < 300; i++) {
		const result = await page
			.evaluate((name) => {
				const entry = window.__log.find((e) =>
					e.url.endsWith(`/rewrite-js?name=${name}`),
				);
				const ran = !!window.__frame.element.contentWindow.__rc?.some(
					([n]) => n === name,
				);
				return entry && ran ? { where: entry.rewriteIn, ran } : null;
			}, name)
			.catch(() => null);
		if (result) return result;
		await sleep(50);
	}
	return { where: 'none', ran: false };
}

// the service worker's modules outlive a controller, so the JavaScript-only
// state can be seen only where the demo itself did not start with wasm
if (process.env.STOMP_REWRITER !== 'wasm') {
	ok(
		"a 'js' controller shakes hands",
		await controller('wasm-share-js', { rewriteWorkers: 1 }),
	);
	const none = await held(() => true);
	ok(
		"with rewriter 'js' no thread is handed a module",
		none.serviceWorker.length === 0 &&
			none.rewriteWorkers.every((names) => names.length === 0),
		JSON.stringify(none),
	);
	const list = await page.evaluate(() => window.__controller.suffixList());
	ok('and tldts answers the service worker its sites', list === null, list);
}

ok(
	"a 'wasm' controller shakes hands with the service worker",
	await controller('wasm-share', { rewriter: 'wasm', rewriteWorkers: 2 }),
);
{
	const all = await held(
		(now) =>
			holdsAll(now.serviceWorker) &&
			now.rewriteWorkers.length === 2 &&
			now.rewriteWorkers.every(holdsAll),
	);
	ok(
		'the service worker compiled the bytes it was handed',
		holdsAll(all.serviceWorker),
		JSON.stringify(all),
	);
	ok(
		'every rewrite worker holds the compiled modules',
		all.rewriteWorkers.length === 2 && all.rewriteWorkers.every(holdsAll),
		JSON.stringify(all),
	);
	const pins = readFileSync(
		new URL('../../rust/suffix/src/pins.env', import.meta.url),
		'utf8',
	);
	const pinned = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(pins)?.[1];
	const list = await page.evaluate(() => window.__controller.suffixList());
	ok(
		"the service worker's sites are answered from the suffix module's list",
		list?.commit === pinned('PSL_COMMIT') && list?.date === pinned('PSL_DATE'),
		JSON.stringify(list),
	);
	const result = await load('w');
	ok(
		'a page loads and its script runs, rewritten in a worker',
		result.ran && result.where === 'pool',
		JSON.stringify(result),
	);
	const styled = await loadStyled();
	ok(
		'a stylesheet is rewritten by the scanner module',
		styled.sheet === 200 && styled.by === 'wasm',
		JSON.stringify(styled),
	);
	ok(
		'and its url() is routed as before',
		styled.image === 200 && styled.destination === 'image',
		JSON.stringify(styled),
	);

	// the page: a proxied top asks its controller for the compiled module
	// and the rewriter library it shares with its frames instantiates it.
	// What the page evaluates is then the module's rewrite, which keeps the
	// page's own comments (the JavaScript rewriter prints none)
	const inPage = (work) =>
		page.evaluate((work) => {
			const top = window.__frame.element.contentWindow;
			const client = top[window.__controller.config.names.client];
			// what really runs, read with this realm's own toString
			const written = (realm) =>
				Function.prototype.toString.call(
					new realm.Function('/* kept */ return location.href;'),
				);
			if (work === 'holds') return client.sharedRewriter.holds('rewriter');
			if (work === 'suffix') {
				const library = client.sharedRewriter;
				return {
					holds: library.holds('suffix'),
					list: library.suffixList(),
					answers: [
						library.domain('a.b.github.io'),
						library.publicSuffix('a.b.github.io', false),
						library.publicSuffix('a.b.github.io', true),
						library.domain('www.example.co.uk'),
						library.domain('127.0.0.1'),
					],
				};
			}
			if (work === 'top') return written(top);
			const frame = top.document.createElement('iframe');
			top.document.body.append(frame);
			const child = frame.contentWindow;
			const childClient = child[window.__controller.config.names.client];
			return {
				own: childClient.sharedRewriter === null,
				text: written(child),
			};
		}, work);
	let holds = false;
	for (let i = 0; i < 100 && !holds; i++) {
		holds = await inPage('holds').catch(() => false);
		if (!holds) await sleep(100);
	}
	ok("the top's rewriter library holds the compiled module", holds);
	const sites = await inPage('suffix');
	ok(
		"the top's library holds the suffix module, and its sites are answered from the module's list",
		sites.holds &&
			sites.list === `${pinned('PSL_COMMIT')} ${pinned('PSL_DATE')}` &&
			JSON.stringify(sites.answers) ===
				JSON.stringify(['github.io', 'github.io', 'io', 'example.co.uk', null]),
		JSON.stringify(sites),
	);
	const top = await inPage('top');
	ok(
		'what the page evaluates is rewritten by the module',
		top.includes('/* kept */') && top.includes('.get(location'),
		top,
	);
	const child = await inPage('frame');
	ok(
		"a frame under it makes no library of its own and uses the top's instance",
		child.own &&
			child.text.includes('/* kept */') &&
			child.text.includes('.get(location'),
		JSON.stringify(child),
	);

	// a page that replaces what a message is read with before the module
	// arrives, to answer it with a module of its own (one that hands every
	// script back as it came): the inject reads that message with getters
	// it took before any page script, so the top holds the controller's
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/wasm-page-module.html`,
	);
	let swapped = null;
	for (let i = 0; i < 100 && !swapped; i++) {
		swapped = await page
			.evaluate(() => {
				const top = window.__frame.element.contentWindow;
				const client = top[window.__controller.config.names.client];
				if (!top.__swap || !client?.sharedRewriter?.holds('rewriter'))
					return null;
				return {
					asked: top.__swap.asked,
					text: Function.prototype.toString.call(
						new top.Function('/* kept */ return location.href;'),
					),
				};
			})
			.catch(() => null);
		if (!swapped) await sleep(100);
	}
	ok(
		"a page cannot hand its top a module of its own: the message is not read with the page's getter, and what it evaluates is still rewritten",
		swapped?.asked === 0 && swapped.text.includes('.get(location'),
		JSON.stringify(swapped),
	);
}

// another controller of the scope (a second host tab): its handshake carries
// the bytes again and the worker keeps the module it has
ok(
	"a second 'wasm' controller shakes hands",
	await controller('wasm-share-2', { rewriter: 'wasm', rewriteWorkers: 0 }),
);
{
	const again = await held((now) => holdsAll(now.serviceWorker));
	ok(
		'the service worker still holds the modules',
		holdsAll(again.serviceWorker) && again.rewriteWorkers.length === 0,
		JSON.stringify(again),
	);
	const result = await load('s');
	ok(
		'a page loads and its script runs, rewritten in the service worker',
		result.ran && result.where === 'service-worker',
		JSON.stringify(result),
	);

	// A worker that was stopped starts again knowing nothing: the request
	// that woke it waits for its controller's handshake, which carries the
	// modules' bytes, and a stylesheet waits for their compile. The first
	// stylesheet of the new worker (here the request that wakes it) is the
	// module's, not css-tree's.
	await loadStyled();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	let stopped = false;
	cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
		if (versions.some((version) => version.runningStatus === 'stopped'))
			stopped = true;
	});
	await cdp.send('ServiceWorker.stopAllWorkers');
	for (let i = 0; i < 40 && !stopped; i++) await sleep(100);
	const from = await page.evaluate(() => window.__log.length);
	await page.evaluate(() => {
		const inner = window.__frame.element.contentDocument;
		const link = inner.createElement('link');
		link.rel = 'stylesheet';
		link.href = '/pages/reqlog.css?after-restart';
		inner.head.append(link);
	});
	let first;
	for (let i = 0; i < 300 && !first; i++) {
		first = await page.evaluate(
			(from) =>
				window.__log
					.slice(from)
					.find((e) => e.url.includes('/reqlog.css?after-restart') && e.status),
			from,
		);
		if (!first) await sleep(50);
	}
	ok(
		'the first stylesheet of a service worker that was restarted is rewritten by the scanner module',
		stopped && first?.status === 200 && first.rewriteBy === 'wasm',
		JSON.stringify({
			stopped,
			status: first?.status,
			by: first?.rewriteBy,
		}),
	);
}

await done(browser);
