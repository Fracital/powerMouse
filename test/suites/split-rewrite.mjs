// A large webpack bundle is rewritten by the wasm module and runs as
// natively. Discord's 13 MB main bundle, a minified page script of 512 KB or
// more (here the runtime form: an IIFE declaring a table of 2000 module
// functions): the module rewrites it whole in one rewrite worker (or the
// service worker), faster than splitting it across workers would plan to, so
// the bundle is never cut into groups. Its modules read location and top,
// index an object, eval and use BigInts; the results hash the same as the
// page loaded natively. The request log says the bundle was rewritten in the
// pool ("pool") whatever the worker count. The same for a Closure module
// bundle (the shape of YouTube's kevlar_base and Google Docs: a function
// called with `.call(this, ...)` whose modules are try statements, one of
// them most of the script), with statements that end at a line break without
// a semicolon and function declarations in its blocks. The suite constructs
// its own controllers on the demo's service worker, as rewrite-cache does.
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();

/** the bundle through a controller with `workers` rewrite workers: its results and its log entry */
async function proxied(workers, name) {
	const PAGE = `${FIXTURE}pages/${name}.html`;
	const page = await openDemo(browser, PROXY);
	await page.evaluate(
		async ({ workers, url }) => {
			const old = window.controller;
			window.__log = [];
			const controller = new window.StompController({
				serviceworker: (
					await navigator.serviceWorker.getRegistration('/stomp/')
				).active,
				transport: old.transport,
				directory: '/stomp/',
				codec: 'xor',
				rewriteWorkers: workers,
				onRequest: (info) => window.__log.push(info),
			});
			await controller.wait();
			// the bundle is rewritten by the module: wait until every thread
			// that will rewrite it holds the core module
			for (let i = 0; i < 100; i++) {
				const held = await controller.wasmModules();
				if (
					held.serviceWorker.includes('core') &&
					held.rewriteWorkers.length === workers &&
					held.rewriteWorkers.every((names) => names.includes('core'))
				)
					break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const element = document.createElement('iframe');
			element.id = 'split-frame';
			document.body.append(element);
			controller.createFrame(element).go(url);
		},
		{ workers, url: PAGE },
	);
	let result = null;
	let entry = null;
	for (let i = 0; i < 240 && !(result && entry); i++) {
		await sleep(250);
		for (const frame of page.frames())
			result ??= await frame
				.evaluate(() => window.__split ?? null)
				.catch(() => null);
		entry = await page.evaluate(
			({ name }) =>
				window.__log.find((info) => info.url.includes(`${name}.js.bin`)),
			{ name },
		);
	}
	await page.close();
	return { result, entry };
}

for (const [name, shape] of [
	['split-bundle', 'webpack'],
	['split-closure', 'Closure'],
]) {
	const native = await (async () => {
		const page = await browser.newPage();
		await page.goto(`${FIXTURE}pages/${name}.html`);
		const value = await page.evaluate(() => window.__split);
		await page.close();
		return value;
	})();
	ok(
		`natively: the ${shape} bundle ran every module`,
		native?.count === 2000,
		JSON.stringify(native),
	);
	for (const workers of [4, 1]) {
		const { result, entry } = await proxied(workers, name);
		ok(
			`${shape}, ${workers} rewrite worker${workers > 1 ? 's' : ''}: the bundle is rewritten whole in the pool`,
			entry?.rewriteIn === 'pool',
			JSON.stringify({ rewriteIn: entry?.rewriteIn, ms: entry?.ms }),
		);
		ok(
			`${shape}, ${workers} rewrite worker${workers > 1 ? 's' : ''}: every module ran as natively`,
			JSON.stringify(result) === JSON.stringify(native),
			`native ${JSON.stringify(native)} proxied ${JSON.stringify(result)}`,
		);
	}
}

await done(browser);
