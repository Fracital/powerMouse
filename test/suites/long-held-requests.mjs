// A request whose answer is held for over a minute is answered when it
// comes, as natively. Chrome puts no time limit on a request's headers (a
// long poll, a server behind a slow upstream), and lets a service worker's
// respondWith run for 5 minutes; STomp's worker answered every routed
// request 504 after 60 s (office.com's scripts behind a slow transport
// failed their integrity check and the page threw), and an emulated
// worker's respondWith went to the network after 30 s. The origin here
// holds /hold's headers for HOLD_MS; the page fetches it and loads it as a
// script, and a page whose worker answers /late-sw after SW_MS fetches that.
// Natively and in both demo modes at once (each case waits its time once).
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

/** past the worker's old 60 s bound */
const HOLD_MS = 65000;
/** past the emulated worker's old 30 s answer time */
const SW_MS = 35000;

const PAGE = `<!doctype html><title>LONG HELD</title><script>
window.__held = (async () => {
	const t0 = Date.now();
	const fetched = fetch('/hold?ms=${HOLD_MS}&k=fetch').then(
		async (r) => r.status + ' ' + (await r.text()),
		(e) => String(e),
	);
	const script = new Promise((resolve) => {
		const s = document.createElement('script');
		s.src = '/hold?ms=${HOLD_MS}&k=script&js=1';
		s.onload = () => resolve('load ' + window.heldScript);
		s.onerror = () => resolve('error');
		document.head.append(s);
	});
	const [fetchResult, scriptResult] = await Promise.all([fetched, script]);
	return { fetch: fetchResult, script: scriptResult, late: Date.now() - t0 >= ${HOLD_MS} - 1000 };
})();
</script>`;
const SW_PAGE = `<!doctype html><title>LONG HELD SW</title><script>
window.__held = (async () => {
	const c = navigator.serviceWorker;
	await c.register('/sw.js');
	for (let i = 0; !c.controller && i < 200; i++)
		await new Promise((r) => setTimeout(r, 50));
	if (!c.controller) return { sw: 'not controlled' };
	const t0 = Date.now();
	const answer = await fetch('/late-sw').then(
		async (r) => r.status + ' ' + (await r.text()),
		(e) => String(e),
	);
	return { sw: answer, late: Date.now() - t0 >= ${SW_MS} - 1000 };
})();
</script>`;
const SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
	if (new URL(e.request.url).pathname !== '/late-sw') return;
	e.respondWith(new Promise((resolve) =>
		setTimeout(() => resolve(new Response('from the worker')), ${SW_MS})));
});`;

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	const send = (type, body) => {
		res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
		res.end(body);
	};
	if (url.pathname === '/page.html') send('text/html; charset=utf-8', PAGE);
	else if (url.pathname === '/sw-page.html')
		send('text/html; charset=utf-8', SW_PAGE);
	else if (url.pathname === '/sw.js') send('text/javascript', SW);
	else if (url.pathname === '/late-sw') send('text/plain', 'from the network');
	else if (url.pathname === '/hold') {
		const timer = setTimeout(
			() =>
				url.searchParams.has('js')
					? send('text/javascript', `window.heldScript = 'held';`)
					: send('text/plain', 'held'),
			Number(url.searchParams.get('ms')),
		);
		req.on('close', () => clearTimeout(timer));
	} else res.writeHead(404).end();
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch();

async function result(page) {
	for (let i = 0; i < 400; i++) {
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__held)
				.catch(() => undefined);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

async function native(path) {
	const page = await browser.newPage();
	// (the held script holds the load event: the page is read as it runs)
	await page.goto(ORIGIN + path, { waitUntil: 'commit' });
	const value = await result(page);
	await page.close();
	return value;
}

async function proxied(base, path) {
	const page = await openDemo(browser, base);
	await submitLanding(page, ORIGIN + path);
	const value = await result(page);
	await page.close();
	return value;
}

const runs = [
	['native', 'page.html', () => native('page.html')],
	['native', 'sw-page.html', () => native('sw-page.html')],
	['same-origin', 'page.html', () => proxied(PROXY, 'page.html')],
	['same-origin', 'sw-page.html', () => proxied(PROXY, 'sw-page.html')],
	['isolated', 'page.html', () => proxied(HOST, 'page.html')],
	['isolated', 'sw-page.html', () => proxied(HOST, 'sw-page.html')],
];
const got = await Promise.all(runs.map(([, , run]) => run()));
const of = (mode, path) =>
	got[runs.findIndex(([m, p]) => m === mode && p === path)];

const nativeHeld = of('native', 'page.html');
const nativeSW = of('native', 'sw-page.html');
ok(
	`natively, a request held ${HOLD_MS / 1000} s is answered, fetched and as a script`,
	nativeHeld?.fetch === '200 held' &&
		nativeHeld.script === 'load held' &&
		nativeHeld.late,
	JSON.stringify(nativeHeld),
);
ok(
	`natively, a respondWith settled after ${SW_MS / 1000} s is the worker's answer`,
	nativeSW?.sw === '200 from the worker' && nativeSW.late,
	JSON.stringify(nativeSW),
);
for (const mode of ['same-origin', 'isolated']) {
	ok(
		`${mode}: a request held ${HOLD_MS / 1000} s is answered as natively`,
		JSON.stringify(of(mode, 'page.html')) === JSON.stringify(nativeHeld),
		JSON.stringify({ native: nativeHeld, proxied: of(mode, 'page.html') }),
	);
	ok(
		`${mode}: an emulated worker's respondWith settled after ${SW_MS / 1000} s is its answer, as natively`,
		JSON.stringify(of(mode, 'sw-page.html')) === JSON.stringify(nativeSW),
		JSON.stringify({ native: nativeSW, proxied: of(mode, 'sw-page.html') }),
	);
}
server.close();
await done(browser);
