// `rewriter: 'wasm'` rewrites scripts with the Rust rewriter (rust/rwjs) in
// the rewrite workers and the service worker: the same rewrites as the
// JavaScript rewriter makes, as edits to the script's own text, so what no
// rewrite touches (a comment, the spacing) comes back as the page wrote it.
// A script the module declines is the JavaScript rewriter's, as is every
// script of a controller that did not ask for wasm.
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);

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

/** a controller of its own (at an address of its own), logging to window.__log */
const controller = (id, options = {}) =>
	page.evaluate(
		async ({ id, options }) => {
			const old = window.controller;
			window.__log = [];
			document.querySelector('#wasm-rewriter-frame')?.remove();
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
			await controller.wait();
			window.__controller = controller;
			const element = document.createElement('iframe');
			element.id = 'wasm-rewriter-frame';
			document.body.append(element);
			window.__frame = controller.createFrame(element);
		},
		{ id, options },
	);

/** every thread the controller hands modules to holds the core module, the rewriter's */
async function settled(workers) {
	for (let i = 0; i < 100; i++) {
		const held = await page.evaluate(() => window.__controller.wasmModules());
		if (
			held.serviceWorker.includes('core') &&
			held.rewriteWorkers.length === workers &&
			held.rewriteWorkers.every((names) => names.includes('core'))
		)
			return true;
		await sleep(100);
	}
	return false;
}

/** load the page whose script is `extra` then the push of `name`: where it was rewritten, whether it ran, what it left on the window */
async function load(name, extra, tries = 300) {
	const read = '__seen';
	const query = `name=${name}&extra=${encodeURIComponent(extra)}`;
	const before = await page.evaluate(() => window.__log.length);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/rewrite-cache.html?s=${encodeURIComponent(query)}`,
	);
	for (let i = 0; i < tries; i++) {
		const result = await page
			.evaluate(
				({ before, name, read }) => {
					const entry = window.__log
						.slice(before)
						.find((e) => e.url.includes(`/rewrite-js?name=${name}&`));
					const frame = window.__frame.element.contentWindow;
					const ran = !!frame.__rc?.some(([n]) => n === name);
					return entry && ran
						? {
								where: entry.rewriteIn,
								by: entry.rewriteBy,
								ran,
								seen: frame[read],
							}
						: null;
				},
				{ before, name, read },
			)
			.catch(() => null);
		if (result) return result;
		await sleep(50);
	}
	return { where: 'none', ran: false };
}

const SCRIPT =
	'/* kept */ function reads(a)  { return a ? top : location.href }\n' +
	'window.__seen = [reads.toString(), reads(0), reads(1) === window.top, typeof eval("1 + 1")];';
const WRITTEN = 'function reads(a)  { return a ? top : location.href }';
const show = (value) => JSON.stringify(value);

await controller('wasm-rewriter', { rewriter: 'wasm', rewriteWorkers: 1 });
ok('every thread holds the rewriter', await settled(1));
{
	const result = await load('p', SCRIPT);
	ok(
		'a script is rewritten in a worker, and runs',
		result.where === 'pool' && result.ran,
		show(result),
	);
	ok(
		'the request log says the module rewrote it',
		result.by === 'wasm',
		show(result.by),
	);
	const [body] = bodiesOf('p');
	ok(
		'what no rewrite touches comes back as written, and the reads go through the access API',
		body?.includes('/* kept */ function') &&
			body.includes('(a)  { return a ? $s$j.get(top, "top") : ') &&
			body.includes('$s$j.get(location, "location").href }'),
		show(body?.slice(0, 600)),
	);
	ok(
		'its function reads back as the page wrote it',
		result.seen?.[0] === WRITTEN,
		show(result.seen),
	);
	ok(
		'the rewritten reads answer for the page: its own URL, its own top, a direct eval',
		result.seen?.[1].startsWith(`${FIXTURE}pages/rewrite-cache.html`) &&
			result.seen[2] === true &&
			result.seen[3] === 'number',
		show(result.seen),
	);
}

await controller('wasm-rewriter-2', { rewriter: 'wasm', rewriteWorkers: 0 });
ok('the service worker holds the rewriter', await settled(0));
{
	const result = await load('p', SCRIPT);
	ok(
		'with no worker the service worker rewrites it, and it runs',
		result.where === 'service-worker' && result.ran,
		show(result),
	);
	ok(
		'and the request log says its module rewrote it',
		result.by === 'wasm',
		show(result.by),
	);
	const seen = bodiesOf('p');
	ok(
		"the worker's output is byte for byte the service worker's",
		seen.length === 2 && seen[0] !== null && seen[0] === seen[1],
		seen[0] === seen[1] ? show(seen.map((body) => body?.length)) : show(seen),
	);
	ok(
		'and its function reads back the same',
		result.seen?.[0] === WRITTEN,
		show(result.seen),
	);

	// a shape the module leaves to the JavaScript rewriter (a pattern key
	// that is a BigInt, beside an unforgeable): that script is printed,
	// not spliced, and runs the same
	const declined = await load(
		'd',
		'/* gone */ const { 1n: half, top: mine } = { 1: "h", top: "t" }; window.__seen = [half, mine];',
	);
	// a key that is no integer is the module's, spelled as JavaScript
	// spells the number
	const keyed = await load(
		'k',
		'/* kept */ const { 1.5: half, 1e21: big, top: mine } = { 1.5: "h", 1e21: "b", top: "t" }; window.__seen = [half, big, mine];',
	);
	const [keyedBody] = bodiesOf('k');
	ok(
		'a pattern key that is no integer is rewritten by the module, and runs',
		keyed.ran &&
			keyed.seen?.join() === 'h,b,t' &&
			keyedBody?.includes('/* kept */'),
		show([keyed, keyedBody?.slice(0, 300)]),
	);
	const [body] = bodiesOf('d');
	ok(
		'a script the module declines is rewritten by the JavaScript rewriter, and runs',
		declined.ran &&
			declined.seen?.join() === 'h,t' &&
			body?.includes('.pattern(') &&
			!body.includes('/* gone */'),
		show([declined, body?.slice(0, 300)]),
	);
	ok(
		'and the request log says the JavaScript rewriter rewrote it',
		declined.by === 'js',
		show(declined.by),
	);

	// a script neither rewriter parses runs as it was written (and fails as
	// it would natively), not as something half rewritten
	const broken = await load('b', 'window.__seen = 1;\nvar 1x;', 40);
	ok(
		'a script that does not parse goes out as it came',
		bodies.some((body) => body?.startsWith('window.__seen = 1;\nvar 1x;')),
		show(broken),
	);
}

// a controller that did not ask for wasm: the JavaScript rewriter, though
// the service worker still holds the module
await controller('wasm-rewriter-js', { rewriteWorkers: 0 });
{
	const result = await load('j', SCRIPT);
	const [body] = bodiesOf('j');
	ok(
		"a 'js' controller's script is the JavaScript rewriter's",
		result.ran &&
			result.seen?.[0] === WRITTEN &&
			body !== undefined &&
			!body.includes('/* kept */') &&
			body.includes("$s$j.get(top, 'top')"),
		show([result, body?.slice(0, 300)]),
	);
	ok(
		'and its request log names no backend',
		result.by === undefined,
		show(result.by),
	);
}

await done(browser, page.errors);
