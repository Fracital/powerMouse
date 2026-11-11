// The CSS a page's own script writes (a style element, a style attribute,
// CSSOM text) is rewritten in the frame's rewriter library. With
// `rewriter: 'wasm'` a proxied top is handed the compiled modules and its
// library rewrites that CSS in the scanner module (rust/rwcss); with
// `rewriter: 'js'`, and until the module has arrived, css-tree does. The two
// write the same text, so which one ran is read from the library's own count
// (`styleRewrites`), and the request for each URL says the text was routed.
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);

/** a controller of its own with a frame of its own (as the wasm-share suite makes them) */
const controller = (id, options = {}) =>
	page.evaluate(
		async ({ id, options }) => {
			const old = window.controller;
			window.__log = [];
			document.querySelector('#css-inject-frame')?.remove();
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
			element.id = 'css-inject-frame';
			element.style.cssText = 'width: 300px; height: 200px';
			document.body.append(element);
			window.__frame = controller.createFrame(element);
			return true;
		},
		{ id, options },
	);

/** what the proxied top's rewriter library says of itself, once the page's script ran */
const library = () =>
	page
		.evaluate(() => {
			const top = window.__frame.element.contentWindow;
			const shared =
				top[window.__controller.config.names.client]?.sharedRewriter;
			if (!top.__styles || !shared) return null;
			const [wasm, js] = shared.styleRewrites().split(' ').map(Number);
			return { holds: shared.holds('scanner'), wasm, js };
		})
		.catch(() => null);

const WAYS = ['element', 'insertRule', 'replaceSync', 'attribute', 'cssText'];

/** the page loaded under a controller of `backend`, and each way of writing CSS run in it */
async function written(backend, n) {
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/css-inject-backend.html`,
	);
	let state = null;
	for (let i = 0; i < 150; i++) {
		state = await library();
		if (state && (backend === 'js' || state.holds)) break;
		await sleep(100);
	}
	const results = {};
	for (const way of WAYS) {
		const before = await library();
		await page.evaluate(
			({ way, n }) => window.__frame.element.contentWindow.__styles[way](n),
			{ way, n },
		);
		let request;
		for (let i = 0; i < 100 && !request; i++) {
			request = await page.evaluate((end) => {
				const entry = window.__log.find((e) => e.url.endsWith(end));
				return entry && entry.status
					? { status: entry.status, destination: entry.destination }
					: undefined;
			}, `/pages/sprite.svg?${way}=${n}`);
			if (!request) await sleep(50);
		}
		const after = await library();
		results[way] = {
			request,
			wasm: after && before ? after.wasm - before.wasm : null,
			js: after && before ? after.js - before.js : null,
		};
	}
	return { state, results };
}

const routed = ({ request }) =>
	request?.status === 200 && request.destination === 'image';

ok(
	"a 'js' controller shakes hands",
	await controller('css-inject-js', { rewriteWorkers: 0 }),
);
{
	const { state, results } = await written('js', 1);
	ok(
		"with rewriter 'js' the top's library holds no scanner",
		state?.holds === false,
		JSON.stringify(state),
	);
	for (const way of WAYS)
		ok(
			`js: ${way} is rewritten by css-tree, and its URL is routed`,
			routed(results[way]) && results[way].js >= 1 && results[way].wasm === 0,
			JSON.stringify(results[way]),
		);
}

ok(
	"a 'wasm' controller shakes hands",
	await controller('css-inject-wasm', { rewriter: 'wasm', rewriteWorkers: 0 }),
);
{
	const { state, results } = await written('wasm', 2);
	ok(
		"with rewriter 'wasm' the top's library holds the scanner",
		state?.holds === true,
		JSON.stringify(state),
	);
	for (const way of WAYS)
		ok(
			`wasm: ${way} is rewritten by the scanner module, and its URL is routed`,
			routed(results[way]) && results[way].wasm >= 1 && results[way].js === 0,
			JSON.stringify(results[way]),
		);
}

await done(browser);
