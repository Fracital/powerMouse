// The request headers a site gets through the proxy are the ones the
// browser sends it: for a navigation, a script, an image, a fetch, an XHR
// and a WebSocket handshake, compared header by header with the page loaded
// natively. Accept-Language was missing on every request (the browser's
// network stack adds it after the service worker, so the worker never saw
// it), an empty Cookie header went where the browser sends none, and the
// handshake lacked Pragma and Cache-Control. Accept-Encoding and the
// handshake's permessage-deflate are the transport's own (what its client
// can decode) and are not compared. Both modes.
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
const KINDS = ['navigation', 'script', 'image', 'fetch', 'xhr', 'ws'];
// what each request's headers are compared on (a header absent on both
// sides agrees)
const HEADERS = [
	'accept',
	'accept-language',
	'user-agent',
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-platform',
	'upgrade-insecure-requests',
	'cache-control',
	'pragma',
	'dnt',
	'priority',
	'cookie',
];

const recorded = (key) =>
	fetch(`${FIXTURE}echo-headers/recorded?k=${key}`).then((r) => r.json());

/** each kind's headers, once the page has made its requests */
async function measure(run, open) {
	// the navigation is a document of its own: the fixture's echo
	await open(`${FIXTURE}echo-headers?k=hp${run}-navigation`);
	await sleep(1500);
	const getFrame = await open(`${FIXTURE}pages/header-parity.html?run=${run}`);
	for (let i = 0; i < 60; i++) {
		if (
			await getFrame()
				?.evaluate(() => window.__parity)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	const seen = {};
	for (const kind of KINDS) seen[kind] = await recorded(`hp${run}-${kind}`);
	return seen;
}

const nativePage = await browser.newPage();
const native = await measure('native', async (url) => {
	await nativePage.goto(url);
	return () => nativePage.mainFrame();
});
await nativePage.close();
ok(
	'natively: every request arrived',
	KINDS.every((kind) => native[kind]),
	JSON.stringify(Object.keys(native).filter((kind) => !native[kind])),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const proxied = await measure(`-${mode}`, async (url) => {
		await submitLanding(page, url);
		return () => frameOf(page);
	});
	for (const kind of KINDS) {
		const differences = HEADERS.filter(
			(name) =>
				(native[kind]?.[name] ?? null) !== (proxied[kind]?.[name] ?? null),
		).map(
			(name) =>
				`${name}: native ${JSON.stringify(native[kind]?.[name] ?? null)} proxied ${JSON.stringify(proxied[kind]?.[name] ?? null)}`,
		);
		ok(
			`${mode}: a ${kind}'s request headers are the browser's`,
			!!proxied[kind] && differences.length === 0,
			proxied[kind] ? differences.join('; ') : 'did not arrive',
		);
	}
	await page.close();
}

await done(browser);
