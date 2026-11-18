// The page's markup that loadHTML rewrites and writes (the text it
// serializes, the pieces it writes it in, the inline scripts' sources it
// reads back while the parser has not run them, the worker's rewrites of
// them) must not outlive the parse. An Error a page script makes while the
// parser runs keeps its stack unformatted until something reads it, and that
// stack holds every function of the call: the page's scripts run inside the
// write, so the function that writes each piece is one of them, and whatever
// its scope still held was kept for the page's life (CNN kept 52 MB that
// way, its whole rewritten markup and its main inline script twice, through
// a Svelte module's Error, and 14 MB more in the worker's table of its
// rewrites). Natively such an Error holds only the page's frames. Measured
// as the JS heap after a GC of a page with a large inline script and an
// Error kept on a global, over that of the same page with a small script,
// against the same pages loaded natively, in same-origin mode, where the
// proxied frame shares the page's renderer and its heap: what a proxied
// document costs of itself (its client) is in both.
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

const MB = 1048576;
const SIZE = 6 * MB;
// the inline script's text is a function the page never calls, so its
// string is never made natively (V8 compiles a function when it first runs)
const pageOf = (size) =>
	'<!doctype html><html><head><title>WRITE-HEAP</title></head><body>' +
	'<p>a page with an inline script</p>' +
	`<script>function neverCalled() { return "${'x'.repeat(size)}"; }\n` +
	'window.__script = typeof neverCalled;</script>' +
	// made while the parser runs, its stack never read
	"<script>window.kept = new Error('kept');</script>" +
	'<p>after</p>' +
	'<script>window.__ready = true;</script>' +
	'</body></html>';
const PAGES = { '/small': pageOf(1024), '/big': pageOf(SIZE) };
const server = createServer((req, res) => {
	const path = new URL(req.url, 'http://x/').pathname;
	res.writeHead(200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(PAGES[path] ?? '<!doctype html><title>EMPTY</title><p>empty');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;
const ROUTE = /\/stomp\/[\w-]+\/html\//;

/** the renderer's JS heap once a full GC has run */
async function heapAfterGC(cdp) {
	for (let i = 0; i < 3; i++) {
		await cdp.send('HeapProfiler.collectGarbage');
		await sleep(150);
	}
	return (await cdp.send('Runtime.getHeapUsage')).usedSize;
}

async function until(get, pred, timeout = 60000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await get().catch(() => null);
		if (pred(value)) return value;
		await sleep(250);
	}
	return null;
}

/**
 * The heap after the small page and after the big one, each loaded in the
 * page `page` (`frame()` its document) after the one before
 */
async function measure(page, frame, navigate) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('HeapProfiler.enable');
	await until(
		() => frame().evaluate(() => document.title),
		(title) => title === 'EMPTY',
	);
	const heaps = {};
	let ready = true;
	for (const name of ['small', 'big']) {
		await navigate(`${ORIGIN}${name}`);
		ready &&= !!(await until(
			() =>
				frame().evaluate(() =>
					window.__ready === true && window.kept instanceof Error
						? window.__script
						: null,
				),
			(value) => value === 'function',
		));
		await sleep(2000);
		heaps[name] = await heapAfterGC(cdp);
	}
	await cdp.detach();
	return { ready, kept: heaps.big - heaps.small };
}

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}empty`);
const native = await measure(
	nativePage,
	() => nativePage.mainFrame(),
	(url) => nativePage.goto(url),
);
await nativePage.close();
ok('natively, the pages run', native.ready, JSON.stringify(native));

const page = await openDemo(browser, PROXY);
await submitLanding(page, `${ORIGIN}empty`);
let current = null;
const frame = () => {
	const found = page.frames().findLast((f) => ROUTE.test(f.url()));
	if (found) current = found;
	return current ?? page.mainFrame();
};
await until(
	async () => frame() !== page.mainFrame(),
	(value) => value === true,
);
const proxied = await measure(page, frame, (url) => submitOmni(page, url));
ok('proxied, the pages run', proxied.ready, JSON.stringify(proxied));

// the written text alone is the script's size (the read-back map and the
// worker's table each held it about twice more: 49 MB in all on Chrome 157):
// a page that keeps none of it keeps about what the small one does over it,
// as natively (1.2 MB more there, its code)
const mb = (bytes) => (bytes / MB).toFixed(2);
ok(
	'the page keeps none of its written markup through a kept Error',
	proxied.ready && native.ready && proxied.kept - native.kept < SIZE / 2,
	`big over small: proxied ${mb(proxied.kept)} MB native ${mb(native.kept)} MB (script ${mb(SIZE)} MB)`,
);

server.close();
server.closeAllConnections();
await done(browser);
