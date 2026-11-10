// A document's inline scripts and styles are rewritten by the service
// worker and its rewrite workers before the page gets them (src/prewrite.ts),
// where the client rewrote each on the page's main thread while it loaded the
// document: the longest task of a page with large inline scripts (CNN, 1.7 s)
// and much of the time Google stayed unresponsive after it painted. The
// client takes the worker's rewrite of a script or a style only for the
// exact same text, so nothing changes but where the work is done: with four
// rewrite workers (prewritten) and with none (the page rewrites, as before),
// a page of classic, module, strict and template scripts, a style, and a
// script the page copies from its own markup runs as natively in both, and
// the worker's rewrites are the ones in the page when it made them. Unless
// SKIP_TIMING, a page with 1 MB of inline scripts has its longest task at
// most two thirds as long prewritten. A script inside a table, parsed again
// in a table section's context by innerHTML (fragment-context) and run as a
// copy, still finds the worker's rewrite by its exact text, and a copy of
// other text falls back to the page's. Same-origin mode (the real text is
// read through the host's realm).
import { done, FIXTURE, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const PAGE = `${FIXTURE}pages/prewrite.html`;
const BIG = `${FIXTURE}pages/prewrite-big.html.bin`;

const native = await (async () => {
	const page = await browser.newPage();
	await page.setContent(`<iframe src="${PAGE}"></iframe>`);
	let value = null;
	for (let i = 0; i < 40 && !value?.done; i++) {
		await sleep(100);
		value = await page
			.frames()[1]
			?.evaluate(() => window.__pw ?? null)
			.catch(() => null);
	}
	await page.close();
	return value;
})();
ok(
	'natively: every script ran, the module last',
	native?.order?.join() === 'a,strict,c,a,cell,cell,cell,other,module' &&
		native?.tableParsed === true,
	JSON.stringify(native),
);

/** the page through a controller with `workers` rewrite workers */
async function proxied(workers, url, read) {
	const page = await openDemo(browser, PROXY);
	await page.evaluate(
		async ({ workers, url }) => {
			const old = window.controller;
			const controller = new window.StompController({
				serviceworker: (
					await navigator.serviceWorker.getRegistration('/stomp/')
				).active,
				transport: old.transport,
				directory: '/stomp/',
				codec: 'xor',
				rewriteWorkers: workers,
			});
			await controller.wait();
			// the workers say they are ready on their own time
			await new Promise((resolve) => setTimeout(resolve, 500));
			const element = document.createElement('iframe');
			element.id = 'prewrite-frame';
			document.body.append(element);
			controller.createFrame(element).go(url);
		},
		{ workers, url },
	);
	let result = null;
	for (let i = 0; i < 240 && !result; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url()))
				result ??= await frame.evaluate(read).catch(() => null);
	}
	await page.close();
	return result;
}

const readSmall = () => {
	if (!window.__pw?.done) return null;
	// the texts as the browser holds them, through the host's realm
	const text = Reflect.getOwnPropertyDescriptor(
		top.Node.prototype,
		'textContent',
	).get;
	const query = top.Document.prototype.querySelectorAll;
	return {
		pw: window.__pw,
		texts: [...query.call(document, 'script, style')].map((node) =>
			text.call(node),
		),
	};
};

const withWorkers = await proxied(4, PAGE, readSmall);
const inPage = await proxied(0, PAGE, readSmall);
for (const [name, result] of [
	['prewritten', withWorkers],
	['rewritten in the page', inPage],
])
	ok(
		`${name}: the page runs as natively`,
		JSON.stringify(result?.pw) === JSON.stringify(native),
		JSON.stringify({ native, proxied: result?.pw }),
	);
// The worker's rewrite carries the script's text for its functions (a
// holder statement), where the page's keeps it in memory: in the page the
// module and the copied script show it only when the worker made them
const holds = (text) => /\.src\("[0-9a-z]+",/.test(text ?? '');
const moduleText = (result) =>
	result?.texts.find((text) => text.includes('inModule'));
// the copy of a markup script the page appended to the head (the last of
// the head's, before the body's table and the copies of its cell script)
const copyText = (result) =>
	result?.texts.filter((text) => text.includes("push('a')")).at(-1);
ok(
	"prewritten, the module and the copy of a markup script are the worker's rewrites; rewritten in the page, they are not",
	holds(moduleText(withWorkers)) &&
		holds(copyText(withWorkers)) &&
		!holds(moduleText(inPage)) &&
		!holds(copyText(inPage)),
	JSON.stringify([
		moduleText(withWorkers)?.slice(0, 120),
		copyText(withWorkers)?.slice(0, 120),
		moduleText(inPage)?.slice(0, 120),
	]),
);

// a script of the markup inside a table, parsed again in a table section's
// context and run as a copy: the same text, so the worker's rewrite when it
// made one; a copy of other text is the page's rewrite either way
const runText = (result) => result?.texts.at(-2);
const otherText = (result) => result?.texts.at(-1);
ok(
	"a table cell's script parsed in a table context matches the worker's rewrite by its text, and other text is rewritten in the page",
	holds(runText(withWorkers)) &&
		!holds(runText(inPage)) &&
		!holds(otherText(withWorkers)) &&
		!holds(otherText(inPage)) &&
		withWorkers?.pw?.tableParsed === true &&
		inPage?.pw?.tableParsed === true,
	JSON.stringify([
		runText(withWorkers)?.slice(0, 120),
		otherText(withWorkers)?.slice(0, 120),
		runText(inPage)?.slice(0, 120),
	]),
);

if (process.env.SKIP_TIMING !== '1') {
	// long tasks are kept for a buffered observer from the document's start
	const readBig = () =>
		window.__bigDone
			? new Promise((resolve) => {
					let longest = 0;
					new PerformanceObserver((list) => {
						for (const entry of list.getEntries())
							longest = Math.max(longest, entry.duration);
					}).observe({ type: 'longtask', buffered: true });
					setTimeout(() => resolve({ done: window.__bigDone, longest }), 300);
				})
			: null;
	const big = async (workers) => {
		let best = null;
		for (let i = 0; i < 2; i++) {
			const result = await proxied(workers, BIG, readBig);
			if (result && (!best || result.longest < best.longest)) best = result;
		}
		return best;
	};
	const prewritten = await big(4);
	const local = await big(0);
	ok(
		'a page with 1 MB of inline scripts runs them all, prewritten and not',
		prewritten?.done?.join() === '6,2000,function' &&
			local?.done?.join() === '6,2000,function',
		JSON.stringify({ prewritten, local }),
	);
	ok(
		'prewritten, its longest task is at most two thirds as long',
		!!prewritten && !!local && prewritten.longest <= (local.longest * 2) / 3,
		JSON.stringify({ prewritten, local }),
	);
}

await done(browser);
