// A navigation that reaches the worker with no referrer and no client still
// carries the Sec-Fetch-Site and Sec-Fetch-User of the document that started
// it: a link clicked in a popup opened without a URL (about:blank sends no
// referrer), with and without user activation, such a popup sending itself
// on by location.href under activation, and a rel=noreferrer link.
// The worker took each for one the user started from the host (`none`,
// `?1`); the document now tells it first (NAVIGATION_HINT). The host's own
// navigation (frame.go) keeps `none` and `?1` and never waits for a hint.
// Both modes, each request compared with the page loaded natively.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const fixture = new URL(FIXTURE);
const CROSS = `http://localhost:${fixture.port}`;
const PAGE = `${FIXTURE}pages/popup-navigation.html`;

/** the request headers the fixture kept for `key`, once they arrived */
async function recorded(key) {
	for (let i = 0; i < 60; i++) {
		const headers = await (
			await fetch(`${FIXTURE}echo-headers/recorded?k=${key}`)
		).json();
		if (headers) return headers;
		await sleep(250);
	}
	return null;
}
const metadata = (headers) =>
	headers && {
		site: headers['sec-fetch-site'] ?? null,
		user: headers['sec-fetch-user'] ?? null,
	};

const CASES = [
	['popup link to another site', 'popup', `${CROSS}/echo-headers`, true],
	['popup link to the same origin', 'popup', `${FIXTURE}echo-headers`, true],
	['popup link clicked by the user', 'popup', `${CROSS}/echo-headers`, false],
	[
		'popup sent to another site by its own location.href, clicked by the user',
		'popupSelf',
		`${CROSS}/echo-headers`,
		false,
	],
	[
		'rel=noreferrer link to another site',
		'noreferrer',
		`${CROSS}/echo-headers`,
	],
];

/** run every case in `frame` (the page's own frame), clicking for the user through `context` popups */
async function runCases(context, getFrame, tag) {
	const seen = {};
	for (const [name, kind, base, click] of CASES) {
		const key = `nav-${tag}-${Date.now()}-${kind}-${click ? 'c' : 'u'}`;
		const url = `${base.replace(/\/$/, '')}?k=${key}`;
		if (kind === 'popup' || kind === 'popupSelf') {
			const popupEvent = context.waitForEvent('page', { timeout: 10000 });
			await getFrame().evaluate(
				([u, c, self]) => (self ? window.__popupSelf(u) : window.__popup(u, c)),
				[url, click, kind === 'popupSelf'],
			);
			const popup = await popupEvent.catch(() => null);
			if (!click && popup) await popup.click('#go').catch(() => {});
			seen[name] = metadata(await recorded(key));
			await popup?.close().catch(() => {});
		} else {
			await getFrame()
				.evaluate((u) => window.__noreferrer(u), url)
				.catch(() => {});
			seen[name] = metadata(await recorded(key));
		}
	}
	return seen;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await runCases(
	nativePage.context(),
	() => nativePage.mainFrame(),
	'native',
);
await nativePage.close();
ok(
	'natively: each navigation reported its headers',
	Object.values(native).every(Boolean),
	JSON.stringify(native),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	if (mode === 'same-origin') {
		// a controller of its own that waits long for a missing hint, so a
		// wait the host's navigation should never pay shows
		await page.evaluate(async () => {
			const old = window.controller;
			const controller = new window.StompController({
				serviceworker: (
					await navigator.serviceWorker.getRegistration('/stomp/')
				).active,
				transport: old.transport,
				directory: '/stomp/',
				codec: 'xor',
				navigationHintWait: 6000,
			});
			await controller.wait();
			const element = document.createElement('iframe');
			element.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
			document.body.append(element);
			window.__frame = controller.createFrame(element);
		});
		// the host navigates: `none` and `?1`, and no hint wait
		const hostKey = `nav-host-${Date.now()}`;
		const started = Date.now();
		await page.evaluate(
			(url) => window.__frame.go(url),
			`${CROSS}/echo-headers?k=${hostKey}`,
		);
		const host = metadata(await recorded(hostKey));
		const hostMs = Date.now() - started;
		ok(
			`${mode}: the host's navigation is the user's (none, ?1) and does not wait for a hint`,
			host?.site === 'none' && host?.user === '?1' && hostMs < 4000,
			JSON.stringify({ ...host, ms: hostMs }),
		);
		await page.evaluate((url) => window.__frame.go(url), PAGE);
	} else await submitLanding(page, PAGE);
	let frame = null;
	for (let i = 0; i < 60 && !frame; i++) {
		await sleep(250);
		const candidate = frameOf(page);
		if (await candidate?.evaluate(() => !!window.__popup).catch(() => false))
			frame = candidate;
	}
	ok(`${mode}: the page loads`, !!frame);
	const proxied = await runCases(page.context(), () => frameOf(page), mode);
	for (const [name] of CASES)
		ok(
			`${mode}: ${name}: Sec-Fetch-Site and Sec-Fetch-User as natively`,
			JSON.stringify(proxied[name]) === JSON.stringify(native[name]),
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied[name])}`,
		);
	await page.close();
}

await done(browser);
