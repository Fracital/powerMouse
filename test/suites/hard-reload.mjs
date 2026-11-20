// A forced reload (Ctrl+Shift+R; CDP Page.reload with ignoreCache) of the
// demo with a proxied page brings the page back as soon as a native one
// comes back, again and again, and what the page stored as it left is there
// when it does. The host page's pagehide tells the service worker its
// controller is going, and Chrome runs it before its frames' own, so what a
// proxied page asked in its pagehide reached the worker after the close: a
// storage read found no controller, went to the host's server and spun to
// the synchronous bridge's 10 s limit on the renderer the reloaded host page
// needed to commit (same-origin mode: nothing on screen for 10 s, 2026-11-19
// on stomp.fracit.al with Twitch, most hard reloads; here 10.6 s from the
// third reload on), and the write the page made as it left was lost. The
// worker now keeps a closed controller's address answered for its
// documents' requests a while.
//
// The suite's HTTP/1 server serves a page that counts its visits in its
// localStorage as it leaves (pagehide, after a moment of work, as a real
// page's handlers take) and reads keys it never wrote. Natively a forced
// reload of it, top level, comes back at once with the count one higher;
// through the demo it is reloaded the same way, three times once it is up
// and four times each as the one before comes back. The host's pages are
// cross-origin isolated, as production's are. Last, the proxied page at the
// top of a tab of its own: Chrome sends its forced reload past the worker,
// to the host's server, which answered "Cannot GET" and now a page that
// reloads once more through the worker (demo/server.js).
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

/** how long the page may take to be back after a forced reload (it waited 10.6 s here) */
const BACK_MS = 8000;

const PAGE = `<!doctype html><title>PAGE</title>
<script>
window.documentId = Math.random();
const left = localStorage.getItem('left');
document.title = 'PAGE ' + (left ?? 'none');
addEventListener('pagehide', () => {
	const until = performance.now() + 100;
	while (performance.now() < until);
	localStorage.getItem('never-written');
	localStorage.setItem('left', String(Number(left ?? 0) + 1));
	localStorage.getItem('never-written-either');
});
</script>`;

const server = createServer((req, res) => {
	if (new URL(req.url, 'http://x').pathname !== '/page.html') {
		res.writeHead(404);
		return res.end();
	}
	res.writeHead(200, {
		'content-type': 'text/html',
		'cache-control': 'no-store',
	});
	res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const SERVER = `http://127.0.0.1:${server.address().port}`;

const browser = await launch();

/** which document `frame` shows */
const documentOf = (frame) =>
	frame?.evaluate(() => globalThis.documentId).catch(() => null) ?? null;

/** the count `frame`'s document read as it loaded, or null before it ran */
const countOf = async (frame) => {
	const title = await frame?.title().catch(() => '');
	const match = /^PAGE (none|\d+)$/.exec(title ?? '');
	if (!match) return null;
	return match[1] === 'none' ? 0 : Number(match[1]);
};

/**
 * Reload `page` past the caches and its service worker, and wait for a new
 * document of the page (`find` picks its frame among `page`'s); its count
 * and how long it took, or null when it was not back within BACK_MS * 3
 */
async function forcedReload(page, find) {
	const before = await documentOf(find(page));
	const cdp = await page.context().newCDPSession(page);
	const started = performance.now();
	await cdp.send('Page.reload', { ignoreCache: true });
	await cdp.detach().catch(() => {});
	while (performance.now() - started < BACK_MS * 3) {
		const frame = find(page);
		const shown = await documentOf(frame);
		if (shown && shown !== before) {
			const count = await countOf(frame);
			if (count !== null)
				return { count, ms: Math.round(performance.now() - started) };
		}
		await sleep(50);
	}
	return null;
}

// natively: the page at the top, which a forced reload loads past its cache
{
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${SERVER}/page.html`);
	let count = await countOf(page.mainFrame());
	const times = [];
	let counted = true;
	for (let i = 0; i < 3; i++) {
		const back = await forcedReload(page, (p) => p.mainFrame());
		times.push(back?.ms ?? 'none');
		counted &&= back?.count === count + 1;
		count = back?.count ?? count;
	}
	ok(
		`native: a forced reload brings the page back within ${BACK_MS} ms, every time`,
		times.every((ms) => typeof ms === 'number' && ms < BACK_MS),
		times.join(', '),
	);
	ok(
		'native: what the page stored as it left is there when it is back',
		counted,
		`count ${count}`,
	);
	await context.close();
}

const routed = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${SERVER}/page.html`);
	let count = null;
	for (let i = 0; i < 200 && count === null; i++) {
		await sleep(100);
		count = await countOf(routed(page));
	}
	ok(`${mode}: the proxied page loads`, count !== null);
	// once it is up: each reload comes back, the count one higher
	const times = [];
	let counted = count !== null;
	for (let i = 0; i < 3 && count !== null; i++) {
		await sleep(500);
		const back = await forcedReload(page, routed);
		times.push(back?.ms ?? 'none');
		counted &&= back?.count === count + 1;
		count = back?.count ?? null;
	}
	ok(
		`${mode}: a forced reload brings the proxied page back within ${BACK_MS} ms, every time`,
		times.length === 3 &&
			times.every((ms) => typeof ms === 'number' && ms < BACK_MS),
		times.join(', '),
	);
	ok(
		`${mode}: what the page stored as it left is there when it is back`,
		counted,
		`count ${count}`,
	);
	// again and again, each as the page before it comes back
	const quick = [];
	for (let i = 0; i < 3 && count !== null; i++) {
		const back = await forcedReload(page, routed);
		quick.push(back?.ms ?? 'none');
		count = back?.count ?? null;
	}
	const last = count === null ? null : await forcedReload(page, routed);
	ok(
		`${mode}: forced reloads one after another leave the page as it was, back within ${BACK_MS} ms`,
		quick.length === 3 &&
			[...quick, last?.ms].every(
				(ms) => typeof ms === 'number' && ms < BACK_MS,
			),
		[...quick, last?.ms ?? 'none'].join(', '),
	);
	// the proxied page at the top of a tab of its own (a popup, a link
	// opened in a new tab): no host page around it, and a forced reload is
	// sent past the worker to the host's server, which had no page there
	if (mode === 'same-origin') {
		const address = routed(page)?.url();
		const [tab] = await Promise.all([
			page.context().waitForEvent('page'),
			page.evaluate(() => window.open('about:blank', '_blank', 'noopener')),
		]);
		await tab.goto(address);
		let shown = null;
		for (let i = 0; i < 100 && shown === null; i++) {
			await sleep(100);
			shown = await countOf(tab.mainFrame());
		}
		const backs = [];
		for (let i = 0; i < 3 && shown !== null; i++) {
			await sleep(500);
			const back = await forcedReload(tab, (p) => p.mainFrame());
			backs.push(back?.ms ?? 'none');
			shown = back?.count ?? null;
		}
		ok(
			`a proxied page at the top of its own tab comes back from a forced reload within ${BACK_MS} ms, every time`,
			backs.length === 3 &&
				backs.every((ms) => typeof ms === 'number' && ms < BACK_MS),
			backs.join(', '),
		);
		await tab.close();
	}
	await page.close();
}

server.close();
await done(browser);
