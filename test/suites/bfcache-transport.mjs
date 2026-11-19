// A proxied page comes back from the back/forward cache as a native one
// does, and goes on to its next page as soon, against Chrome 157 with the
// cache on (Playwright turns it off). Chrome closes a page's WebSockets as
// it goes into the cache, the transport's wisp WebSocket with them, and
// epoxy's own WebSocket never ended its wisp connection on that close: the
// first request after the host came back went to the site's pooled
// connection over it and was never answered (2026-11-19: a link in the
// demo's frame did nothing for good after Back to the demo; natively the
// next page was there in tens of ms). Fixed by RevivingTransport.lost, which
// the controller calls on its page's `pageshow` from the cache.
//
// The suite's HTTP/1 server serves a page with a frame whose page, shown
// again from the cache, goes to the next page of the same server; the
// server times the next page's request from the harness's Back. The same
// steps run natively (the page in a frame of the server's own top page),
// and through the demo, same-origin and isolated: the host leaves for
// another site and comes back.
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

/** how long the next page may take after Back (natively it is tens of ms) */
const NEXT_MS = 5000;

/** when the server saw each run's next page, by its tag */
const arrived = new Map();
const waiters = new Map();

/** the frame's page: shown again from the cache, it goes on to the next page */
const framePage = (tag) => `<!doctype html><title>FRAME</title>
<a id="go" href="/next.html?run=${tag}">next</a>
<script>
addEventListener('pageshow', (event) => {
	if (event.persisted) setTimeout(() => document.getElementById('go').click(), 200);
});
</script>`;

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const tag = url.searchParams.get('run') ?? '';
	const html = (body) => {
		res.writeHead(200, {
			'content-type': 'text/html',
			'cache-control': 'no-store',
		});
		res.end(body);
	};
	if (url.pathname === '/top.html')
		return html(
			`<!doctype html><title>TOP</title><iframe src="/frame.html?run=${tag}"></iframe>`,
		);
	if (url.pathname === '/frame.html') return html(framePage(tag));
	if (url.pathname === '/next.html') {
		arrived.set(tag, performance.now());
		waiters.get(tag)?.();
		return html('<!doctype html><title>NEXT</title>');
	}
	if (url.pathname === '/away.html')
		return html('<!doctype html><title>AWAY</title>');
	res.writeHead(404);
	res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const SERVER = `http://127.0.0.1:${server.address().port}`;
// another site for the host to leave for
const AWAY = `http://localhost:${server.address().port}/away.html`;

/** whether the server saw the run's next page `tag` within `ms` of now, and when */
function nextWithin(tag, from, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		const settle = () => {
			clearTimeout(timer);
			resolve(Math.round(arrived.get(tag) - from));
		};
		if (arrived.has(tag)) return settle();
		waiters.set(tag, settle);
	});
}

/** leave `page` for another site and come back; Chrome's reasons it did not keep it, if any */
async function leaveAndBack(page, tag) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Page.enable');
	const reasons = [];
	cdp.on('Page.backForwardCacheNotUsed', (event) =>
		reasons.push(...event.notRestoredExplanations.map((x) => x.reason)),
	);
	await page.goto(AWAY);
	await sleep(500);
	await page.goBack({ waitUntil: 'commit' });
	const back = performance.now();
	const ms = await nextWithin(tag, back, NEXT_MS);
	await cdp.detach().catch(() => {});
	return { reasons: [...new Set(reasons)].join(' '), ms };
}

const browser = await launch([], { backForwardCache: true });
const errors = [];

// natively: the server's own page with the frame
{
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	const tag = `native-${Date.now()}`;
	await page.goto(`${SERVER}/top.html?run=${tag}`);
	await sleep(1000);
	const { reasons, ms } = await leaveAndBack(page, tag);
	ok(
		'native: the page comes back from the back/forward cache',
		!reasons,
		reasons,
	);
	ok(
		`native: the frame's next page reaches the server within ${NEXT_MS} ms of Back`,
		ms !== null,
		ms === null ? 'none' : `${ms} ms`,
	);
	await context.close();
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	page.on('pageerror', (error) => errors.push(error.message));
	const tag = `${mode}-${Date.now()}`;
	await submitLanding(page, `${SERVER}/frame.html?run=${tag}`);
	// the proxied page is up in its frame
	for (let i = 0; i < 100; i++) {
		const frame = page
			.frames()
			.find((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		if ((await frame?.title().catch(() => '')) === 'FRAME') break;
		await sleep(100);
	}
	await sleep(1000);
	const { reasons, ms } = await leaveAndBack(page, tag);
	ok(
		`${mode}: the demo with a proxied page comes back from the back/forward cache`,
		!reasons,
		reasons,
	);
	ok(
		`${mode}: the frame's next page reaches the server within ${NEXT_MS} ms of Back`,
		ms !== null,
		ms === null ? 'none' : `${ms} ms`,
	);
	await page.context().close();
}

server.close();
await done(browser, errors);
