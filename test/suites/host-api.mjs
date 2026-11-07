// The host-embedding API (WS5 in docs/fracital-integration-handoff.md),
// checked against examples/minimal-host.html: a same-origin StompController
// on epoxy, one frame, the three callbacks. Drives a real HTTP-heavy site
// (Wikipedia), so it belongs in test/run.mjs's NETWORK_SUITES.
import {
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

const START = 'https://en.wikipedia.org/wiki/Web_proxy';
// Web_proxy is a redirect: MediaWiki serves the target and its page script
// replaceState()s the URL to the target's, so "at the start page" is either
const AT_START =
	/^https:\/\/en\.wikipedia\.org\/wiki\/(Web_proxy|Proxy_server#Web_proxy_servers)$/;
const WIKI = /^https:\/\/en\.wikipedia\.org\/wiki\/[^:#?]+(#.*)?$/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const browser = await launch();
await waitForServer(PROXY);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}examples/minimal-host.html`);
await page
	.waitForFunction(() => window.host?.controller.isReady, null, {
		timeout: 45000,
	})
	.then(
		() => ok('example boots a ready controller', true),
		(error) => ok('example boots a ready controller', false, error.message),
	);
ok(
	'status line says Ready',
	(await page.textContent('#status')) === 'Ready',
	await page.textContent('#status'),
);

// every navigate event the frame dispatches, for the checks below
await page.evaluate(() => {
	window.__events = [];
	window.host.frame.addEventListener('navigate', (event) =>
		window.__events.push(event.detail),
	);
});
const events = () => page.evaluate(() => window.__events);
const frameUrl = () => page.evaluate(() => window.host.frame.url);
const address = () =>
	page.evaluate(() => document.getElementById('address').value);
/** the proxied frame as playwright sees it */
const proxied = async () => (await page.$('#view')).contentFrame();
/** wait until frame.url is `where` (a URL or a RegExp) and a navigate report with that URL carried a title */
async function settled(where, timeout = 40000) {
	const source =
		where instanceof RegExp ? where.source : `^${escapeRegExp(where)}$`;
	await page.waitForFunction(
		(src) => {
			const re = new RegExp(src);
			return (
				re.test(window.host.frame.url ?? '') &&
				window.__events.some((e) => re.test(e.url) && e.title)
			);
		},
		source,
		{ timeout },
	);
}

// ---- go, navigate event, title -------------------------------------------

const goResolved = await page
	.evaluate((u) => window.host.frame.go(u).then(() => true), START)
	.catch(() => false);
ok('frame.go resolves', goResolved === true);
await settled(AT_START).then(
	() => ok('page renders after go', true),
	(error) => ok('page renders after go', false, error.message),
);
const title = await page.evaluate(() => window.host.frame.title);
ok(
	'frame.title is the page title',
	/Proxy server|Web proxy/.test(title),
	title,
);
const first = (await events())[0];
ok(
	'navigate event carries url, title, canGoBack, canGoForward',
	first &&
		AT_START.test(first.url) &&
		typeof first.title === 'string' &&
		typeof first.canGoBack === 'boolean' &&
		typeof first.canGoForward === 'boolean',
	JSON.stringify(first),
);
ok(
	'first entry: canGoBack false, canGoForward false',
	first?.canGoBack === false && first?.canGoForward === false,
	JSON.stringify(first),
);
ok(
	'address input follows the page',
	AT_START.test(await address()),
	await address(),
);
ok(
	'Back button disabled at the first entry',
	await page.$eval('#back', (b) => b.disabled),
);

// ---- an in-frame link, then back / forward / back-at-first-entry -----------

// a link to another article; the navigate report arrives before the body
// has parsed, so poll the frame for one (the frame may be navigating)
const LINK = `[...document.links].find((x) => /^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/[^:#?]+$/.test(x.href) && !/Main_Page|Wikipedia$|Proxy_server|Web_proxy/.test(x.href))`;
async function clickLink(timeout = 40000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const frame = await proxied();
			if (frame && (await frame.evaluate(`!!${LINK}`))) {
				await frame.evaluate(`${LINK}.click()`);
				return true;
			}
		} catch {
			// navigating
		}
		await sleep(250);
	}
	return false;
}
ok('the page has article links', await clickLink());
await page
	.waitForFunction(
		(src) => !new RegExp(src).test(document.getElementById('address').value),
		AT_START.source,
		{ timeout: 30000 },
	)
	.then(
		() => ok('address input follows an in-frame link', true),
		(error) =>
			ok('address input follows an in-frame link', false, error.message),
	);
// the article may itself be a redirect that rewrites its URL: let it settle
await sleep(1500);
const second = await frameUrl();
ok('the link led to another article', WIKI.test(second), second);
await settled(second).catch(() => {});
ok(
	'frame.url agrees with the address input',
	(await frameUrl()) === second,
	await frameUrl(),
);
ok(
	'Back button enabled after the link',
	!(await page.$eval('#back', (b) => b.disabled)),
);

const back1 = await page.evaluate(() => window.host.frame.back());
ok('frame.back() resolves true', back1 === true, String(back1));
await settled(AT_START).then(
	() => ok('back returns to the first url', true),
	(error) => ok('back returns to the first url', false, error.message),
);
ok(
	'canGoForward true after back',
	(await page.evaluate(() => window.host.frame.canGoForward)) === true,
);

const fwd = await page.evaluate(() => window.host.frame.forward());
ok('frame.forward() resolves true', fwd === true, String(fwd));
await settled(second).then(
	() => ok('forward returns to the second url', true),
	(error) => ok('forward returns to the second url', false, error.message),
);

const back2 = await page.evaluate(() => window.host.frame.back());
ok('frame.back() resolves true again', back2 === true, String(back2));
await settled(AT_START).catch(() => {});
const back3 = await page.evaluate(() => window.host.frame.back());
ok(
	'frame.back() at the first entry resolves false',
	back3 === false,
	String(back3),
);
ok(
	'the host page did not move',
	(await page.url()) === `${PROXY}examples/minimal-host.html`,
	await page.url(),
);

// ---- reload -----------------------------------------------------------------

const before = (await events()).length;
await page.evaluate(() => window.host.frame.reload());
await page
	.waitForFunction(
		([n, src]) => {
			const re = new RegExp(src);
			return (
				window.__events.length > n &&
				window.__events.slice(n).some((e) => re.test(e.url) && e.title) &&
				re.test(window.host.frame.url ?? '')
			);
		},
		[before, AT_START.source],
		{ timeout: 40000 },
	)
	.then(
		() => ok('frame.reload() brings the page back', true),
		(error) => ok('frame.reload() brings the page back', false, error.message),
	);
await sleep(500);
const flags = await page.evaluate(() => ({
	canGoBack: window.host.frame.canGoBack,
	canGoForward: window.host.frame.canGoForward,
	last: window.host.frame.lastNavigate,
	back: document.getElementById('back').disabled,
	forward: document.getElementById('forward').disabled,
}));
ok(
	'canGoBack false and canGoForward true at the first entry with a forward entry',
	flags.canGoBack === false && flags.canGoForward === true,
	JSON.stringify(flags),
);
ok(
	'the last navigate report agrees with the getters',
	flags.last?.canGoBack === flags.canGoBack &&
		flags.last?.canGoForward === flags.canGoForward,
	JSON.stringify(flags.last),
);
ok(
	'buttons reflect canGoBack / canGoForward',
	flags.back === true && flags.forward === false,
	JSON.stringify(flags),
);

// ---- onRequest --------------------------------------------------------------

const log = (await page.textContent('#log')).split('\n').filter(Boolean);
ok('onRequest logged requests', log.length > 0, `${log.length} lines`);
ok('the log is capped at 50 lines', log.length <= 50, `${log.length} lines`);
ok(
	'requests carry real URLs',
	log.some((line) => / https:\/\/en\.wikipedia\.org\//.test(line)) &&
		!log.some((line) => line.includes('/stomp/')),
	log.slice(-3).join(' | '),
);
// subresources the head fetches before the page has reported its client id
// arrive without a frame (documented: `frame` when the page has reported)
const unattributed = log.filter((line) => line.startsWith('- '));
ok(
	'most requests are attributed to the frame',
	unattributed.length < log.length / 2,
	`${unattributed.length} of ${log.length} without a frame`,
);

// ---- cookies, cache, stale / rebind ------------------------------------------

const api = (member, args) =>
	page.evaluate(
		([m, a]) => window.host.controller[m[0]][m[1]](...a),
		[member, args],
	);
const wikiCookies = await api(
	['cookies', 'list'],
	['https://en.wikipedia.org'],
).catch((error) => error.message);
ok(
	'cookies.list(origin) returns an array',
	Array.isArray(wikiCookies),
	Array.isArray(wikiCookies)
		? `${wikiCookies.length} cookies`
		: String(wikiCookies),
);
const fixtureOrigin = new URL(FIXTURE).origin;
await api(['cookies', 'set'], [`${FIXTURE}pages/x`, 'host=1; Path=/']);
const got = await api(['cookies', 'get'], [`${FIXTURE}pages/y`]);
ok('cookies.set then get round-trips', got === 'host=1', JSON.stringify(got));
const listed = await api(['cookies', 'list'], [fixtureOrigin]);
ok(
	'cookies.list(origin) shows the cookie',
	listed.some((c) => c.name === 'host' && c.value === '1'),
	JSON.stringify(listed),
);
await api(['cookies', 'clear'], [fixtureOrigin]);
ok(
	'cookies.clear(origin) removes it',
	(await api(['cookies', 'get'], [`${FIXTURE}pages/y`])) === '',
);

const cleared = await page
	.evaluate(() => window.host.controller.clearCache().then(() => true))
	.catch((error) => error.message);
ok('clearCache() resolves', cleared === true, String(cleared));

const staleState = await page.evaluate(() => {
	const c = window.host.controller;
	const listeners = { stale: false, rebind: false };
	c.addEventListener('stale', () => (listeners.stale = true));
	c.addEventListener('rebind', () => (listeners.rebind = true));
	return {
		stale: c.stale,
		isEventTarget: c instanceof EventTarget,
		attached: Object.keys(listeners),
	};
});
ok(
	'controller.stale is null on a matching build',
	staleState.stale === null,
	JSON.stringify(staleState.stale),
);
ok(
	'stale / rebind listeners attach (controller is an EventTarget)',
	staleState.isEventTarget && staleState.attached.length === 2,
);

// ---- onOpen -----------------------------------------------------------------

// The example's onOpen opens the URL in its one frame, so a window.open from
// the page shows up as a navigation to that URL and the page gets null back.
const opened = await (
	await proxied()
).evaluate(() => window.open('https://example.com'));
ok(
	'window.open in the page returns null (handed to the host)',
	opened === null,
	String(opened),
);
await settled('https://example.com/').then(
	() => ok('onOpen received the URL and the host opened it', true),
	(error) =>
		ok('onOpen received the URL and the host opened it', false, error.message),
);
ok(
	'the opened page rendered',
	(await page.evaluate(() => window.host.frame.title)) === 'Example Domain',
	await page.evaluate(() => window.host.frame.title),
);
// a small page, so its document line is still in the capped log
await sleep(500);
const tail = (await page.textContent('#log')).split('\n').filter(Boolean);
ok(
	'the document load is attributed to the frame (info.frame === frame)',
	tail.some((line) =>
		/^0 GET 200 (document|iframe) https:\/\/example\.com\//.test(line),
	),
	tail.find((line) => line.includes('https://example.com/')) ||
		'(no document line)',
);

await done(browser, errors.filter((e) => !e.includes('404')).slice(0, 5));
