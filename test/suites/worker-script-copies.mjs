// What the service worker leaves to its garbage collector for a script it
// rewrites, and what it keeps of it: the body as it arrived (its chunks)
// and the body read whole, which the rewrite and its cache key need, are
// all it leaves, and it keeps nothing. The worker shares the renderer of
// the frames it serves in same-origin mode, and an idle worker never
// collects, so every copy of a body it makes stays in that renderer until
// the next collection, load after load, and what it keeps stays there.
// The rewrite cache's key joined the body to its other parts in one more
// buffer, on a hit as on a miss; the rewritten text went out as UTF-8
// bytes of the worker's own, which the same document's repeat kept for
// 30 s and the page's Response and the cache's each copied again; and the
// memory cache kept each entry as an ArrayBuffer (up to 96 MB of them),
// copied again into each Response it answered with. The key is a digest of
// the parts and the body's own digest now, and the output and the memory
// cache's entries are Blobs, which the browser keeps. A 4 MB script,
// loaded in a new document each time: served with no-cache, a miss and
// then a hit of the rewrite cache; served fresh for ten minutes, a load
// the memory cache keeps and then its answer. Each load leaves about two
// bodies (8 MB; 21.5, 12, 25.5 and 8 MB before) and the worker keeps none
// (it kept 9.4 MB after the miss and 13.4 MB after the memory cache's
// load), and the script runs as natively.
import { createServer } from 'node:http';
import {
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';
import { workerMemory } from '../worker-memory.mjs';

const MB = 1000 * 1000;

/** a script of about `size` bytes that defines a lot of small functions, like a bundle */
function bundle(size) {
	const parts = ['var big = {};\n'];
	let length = parts[0].length;
	for (let i = 0; length < size; i++) {
		const line = `big.f${i} = function (a) { return a + ${i} + "${(i * 7919).toString(36)}"; };\n`;
		parts.push(line);
		length += line.length;
	}
	parts.push('window.__ran = Object.keys(big).length;\n');
	return Buffer.from(parts.join(''));
}
const SCRIPT = bundle(4 * MB);
const FUNCTIONS = SCRIPT.toString().split('\n').length - 3;

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/warm.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>WARM</title><p>warm</p>');
	} else if (url.pathname === '/page.html') {
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		});
		const script = url.searchParams.get('script');
		res.end(
			`<!doctype html><title>SCRIPT COPIES</title><script src="/${script}.js"></script>`,
		);
	} else if (url.pathname === '/big.js' || url.pathname === '/kept.js') {
		// big.js is asked again for every load, and kept only as a rewrite
		// (a rewrite cache entry); kept.js is fresh for ten minutes, so the
		// memory cache keeps it too and answers the next document's load
		res.writeHead(200, {
			'content-type': 'text/javascript',
			'content-length': SCRIPT.length,
			'cache-control':
				url.pathname === '/big.js' ? 'no-cache' : 'public, max-age=600',
		});
		res.end(SCRIPT);
	} else res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch();
const workers = await workerMemory(browser);

const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html?script=big`);
const native = await nativePage.evaluate(() => window.__ran ?? null);
await nativePage.close();
ok('natively, the script runs', native === FUNCTIONS, String(native));

const page = await openDemo(browser, PROXY);
const ROUTED = /\/stomp\/[\w-]+\/html[:/]/;
/** what a proxied document that was not there before ran, once it has */
const ran = async () => {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames().filter((f) => ROUTED.test(f.url()))) {
			const value = await frame
				.evaluate(() => (window.__old ? null : (window.__ran ?? null)))
				.catch(() => null);
			if (value !== null) return value;
		}
	}
	return null;
};
/** the documents there now are not the next one */
const marked = () =>
	Promise.all(
		page
			.frames()
			.map((f) => f.evaluate(() => (window.__old = true)).catch(() => {})),
	);
// the worker's first proxied page (its own scripts and the inject's) is
// not what is measured
await submitLanding(page, `${ORIGIN}warm.html`);
for (let i = 0; i < 120; i++) {
	await sleep(250);
	const title = await page
		.frames()
		.findLast((f) => ROUTED.test(f.url()))
		?.evaluate(() => document.title)
		.catch(() => null);
	if (title === 'WARM') break;
}
const inMB = (bytes) => (bytes === null ? null : bytes / MB);
for (const [load, script] of [
	['a miss', 'big'],
	['a hit', 'big'],
	['a script the memory cache keeps', 'kept'],
	["the memory cache's answer", 'kept'],
]) {
	await marked();
	const before = await workers.memory();
	const held = await workers.uncollected('sw');
	await submitOmni(
		page,
		`${ORIGIN}page.html?script=${script}&load=${encodeURIComponent(load)}`,
	);
	const value = await ran();
	// (the caches' puts settle after the page has the script)
	await sleep(1000);
	const left = await workers.uncollected('sw');
	const after = await workers.memory();
	const grew = held === null || left === null ? null : left - held;
	const kept =
		before.sw && after.sw ? after.sw.buffers - before.sw.buffers : null;
	ok(
		`${load}: the script runs as natively`,
		value === native,
		JSON.stringify({ native, proxied: value }),
	);
	ok(
		`${load}: the worker leaves about two copies of the body to its collector`,
		grew !== null && grew < SCRIPT.length * 2.5,
		JSON.stringify({ grewMB: inMB(grew), bodyMB: inMB(SCRIPT.length) }),
	);
	// the rewrite cache's entries, the memory cache's and the same
	// document's repeat are the browser's Blobs, not the worker's memory
	ok(
		`${load}: the worker keeps no copy of the body in its own memory`,
		kept !== null && kept < SCRIPT.length / 4,
		JSON.stringify({ keptMB: inMB(kept) }),
	);
}

await workers.detach();
server.close();
server.closeAllConnections();
await done(browser, page.errors);
