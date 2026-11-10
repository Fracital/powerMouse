// `rewriter: 'wasm'`: the controller loads the wasm modules once and every
// thread that rewrites holds them (src/wasm/thread.ts). The rewrite workers
// get the compiled modules; the service worker gets their bytes with the
// handshake, because a message holding a WebAssembly.Module never reaches a
// service worker (it is an agent cluster of its own) and a handshake that
// carried one left the controller waiting for the worker forever. A page
// loads and runs as before either way: a module only ever answers what the
// JavaScript rewriter would have.
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
}

ok(
	"a 'wasm' controller shakes hands with the service worker",
	await controller('wasm-share', { rewriter: 'wasm', rewriteWorkers: 2 }),
);
{
	const all = await held(
		(now) =>
			now.serviceWorker.includes('rewriter') &&
			now.rewriteWorkers.length === 2 &&
			now.rewriteWorkers.every((names) => names.includes('rewriter')),
	);
	ok(
		'the service worker compiled the bytes it was handed',
		all.serviceWorker.includes('rewriter'),
		JSON.stringify(all),
	);
	ok(
		'every rewrite worker holds the compiled module',
		all.rewriteWorkers.length === 2 &&
			all.rewriteWorkers.every((names) => names.includes('rewriter')),
		JSON.stringify(all),
	);
	const result = await load('w');
	ok(
		'a page loads and its script runs, rewritten in a worker',
		result.ran && result.where === 'pool',
		JSON.stringify(result),
	);
}

// another controller of the scope (a second host tab): its handshake carries
// the bytes again and the worker keeps the module it has
ok(
	"a second 'wasm' controller shakes hands",
	await controller('wasm-share-2', { rewriter: 'wasm', rewriteWorkers: 0 }),
);
{
	const again = await held((now) => now.serviceWorker.includes('rewriter'));
	ok(
		'the service worker still holds the module',
		again.serviceWorker.includes('rewriter') &&
			again.rewriteWorkers.length === 0,
		JSON.stringify(again),
	);
	const result = await load('s');
	ok(
		'a page loads and its script runs, rewritten in the service worker',
		result.ran && result.where === 'service-worker',
		JSON.stringify(result),
	);
}

await done(browser);
