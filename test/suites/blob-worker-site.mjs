// A blob: worker's requests are judged as the page that made it, as the
// browser does: an importScripts and a fetch to another site carry
// Sec-Fetch-Site cross-site and, with the default credentials
// (same-origin), no cookie; a fetch to the page's own origin is
// same-origin and carries its SameSite=Strict cookie. The worker cannot
// decode a blob: URL to a page, so the page tells it which blob: URLs it
// minted. Both modes, each request compared with the page loaded natively.
// After the service worker restarts it still knows (it keeps what it was
// told in IndexedDB): the live worker's requests are judged as before, as
// natively, and they still run (one of an unknown origin would be judged as
// an opaque origin's, its CORS requests refused).
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
// another site: the fixture under localhost (an IP and a name share no site)
const CROSS = `http://localhost:${fixture.port}`;

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

/** what each of a round's requests showed: its site, and whether the Strict cookie went */
async function measure(getFrame, key, tag = 'first') {
	const slot = tag === 'first' ? '__blobSite' : '__blobAgain';
	let result = null;
	for (let i = 0; i < 240 && !result; i++) {
		await sleep(250);
		result = await getFrame()
			?.evaluate((slot) => window[slot] ?? null, slot)
			.catch(() => null);
	}
	const imported = await (
		await fetch(`${FIXTURE}echo-headers/recorded?k=${key}-${tag}-import`)
	).json();
	const seen = (headers) => ({
		site: headers?.['sec-fetch-site'] ?? null,
		strict: (headers?.cookie ?? '').includes('strict=1'),
	});
	return {
		error: result ? (result.error ?? null) : 'no report',
		import: seen(imported),
		cross: seen(result?.cross),
		same: seen(result?.same),
		include: seen(result?.include),
		retries: result?.retries ?? null,
	};
}

const pageURL = (key) =>
	`${FIXTURE}pages/blob-worker-site.html?k=${key}&cross=${encodeURIComponent(CROSS)}`;

// natively: the cookies set by loading each site's page, then the worker
const nativeKey = `blob-native-${Date.now()}`;
const nativePage = await browser.newPage();
await nativePage.goto(`${CROSS}/pages/blob-worker-site.html?setup`);
await nativePage.goto(pageURL(nativeKey));
const native = await measure(() => nativePage.mainFrame(), nativeKey);
await nativePage.close();
ok(
	'natively: an importScripts and a fetch to another site are cross-site without its Strict cookie, the own origin same-origin with it',
	!native.error &&
		native.import.site === 'cross-site' &&
		native.cross.site === 'cross-site' &&
		!native.cross.strict &&
		native.same.site === 'same-origin' &&
		native.same.strict,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const key = `blob-${mode}-${Date.now()}`;
	const page = await openDemo(browser, base);
	// a Strict cookie for each site, set through the proxy's jar
	await submitLanding(page, `${CROSS}/pages/blob-worker-site.html?setup`);
	await sleep(1500);
	await submitLanding(page, pageURL(key));
	const proxied = await measure(() => frameOf(page), key);
	ok(
		`${mode}: the blob worker ran its requests`,
		!proxied.error,
		JSON.stringify(proxied.error),
	);
	for (const [request, label] of [
		['import', 'importScripts from another site'],
		['cross', 'fetch to another site'],
		['same', "fetch to its page's own origin"],
	])
		ok(
			`${mode}: a blob worker's ${label}: Sec-Fetch-Site and the Strict cookie as natively`,
			JSON.stringify(proxied[request]) === JSON.stringify(native[request]),
			`native ${JSON.stringify(native[request])} proxied ${JSON.stringify(proxied[request])}`,
		);

	// the service worker restarts (Chrome stops an idle one), which empties
	// its memory: the live worker's next requests come from a blob: URL it
	// knows only from its store
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	let stopped = false;
	cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
		if (versions.some((version) => version.runningStatus === 'stopped'))
			stopped = true;
	});
	await cdp.send('ServiceWorker.stopAllWorkers');
	// the round starts once the worker is down: its first request wakes it
	for (let i = 0; i < 40 && !stopped; i++) await sleep(100);
	await cdp.detach();
	await frameOf(page)?.evaluate(() => window.__blobWorker.postMessage('again'));
	const again = await measure(() => frameOf(page), key, 'again');
	ok(
		`${mode}: after a service worker restart the blob worker's requests still run`,
		!again.error,
		again.error
			? JSON.stringify(again.error)
			: `${again.retries} retries of 500 ms while the worker came back`,
	);
	for (const [request, label] of [
		['import', 'importScripts from another site'],
		['cross', 'fetch to another site'],
		['same', "fetch to its page's own origin"],
	])
		ok(
			`${mode}: after a restart, a blob worker's ${label} is judged as natively`,
			JSON.stringify(again[request]) === JSON.stringify(native[request]),
			`native ${JSON.stringify(native[request])} proxied ${JSON.stringify(again[request])}`,
		);
	ok(
		`${mode}: after a restart, its credentialed fetch to its own origin carries the Strict cookie, as natively`,
		JSON.stringify(again.include) === JSON.stringify(native.include),
		`native ${JSON.stringify(native.include)} proxied ${JSON.stringify(again.include)}`,
	);
	await page.close();
}

await done(browser);
