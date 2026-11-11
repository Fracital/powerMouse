// A URL property a page sets reaches the site only through the proxy. The
// page (property-sets.html) sets every load property there is (src,
// srcset, poster, href, data) on a detached element and on one already in
// the document, each URL marked ?prop=<kind>; the bypass recorder sees every
// request of the context, and none may go straight to the page's real host.
// A connected script, stylesheet or frame given its URL by property would
// otherwise load it from the site, past the proxy. Both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const host = new URL(FIXTURE).host;
const CONNECTED = ['script-src', 'link-href', 'img-src', 'iframe-src'];
// the holder's own loads of the ?read page, before it is read back
const OWN = ['read-link', 'read-img', 'read-srcset', 'read-shadow'];

/** poll `probe` (every 100 ms, for 30 s) until it answers something truthy */
async function until(probe) {
	for (let i = 0; i < 300; i++) {
		const value = await probe();
		if (value) return value;
		await sleep(100);
	}
	return null;
}

/** the frame of `page` in which `probe` holds, once there is one */
const frameWhere = (page, probe) =>
	until(async () => {
		for (const frame of page.frames())
			if (await frame?.evaluate(probe).catch(() => false)) return frame;
		return null;
	});

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await page.evaluate(() => {
		window.__served = [];
		window.controller.addEventListener('request', (event) =>
			window.__served.push(event.detail.url),
		);
	});
	await submitLanding(page, `${FIXTURE}pages/property-sets.html`);
	// the page says when its sets are two seconds old. The controller holds a
	// frame's document request for up to three seconds (until a frame of its
	// own claims it, which a page's inner frame never does), so that report
	// is waited for: a fixed sleep from here lost to a slow load
	await frameWhere(page, () => window.__propertySets?.done === true);
	const connected = (served) =>
		CONNECTED.every((kind) =>
			served.some((url) => url.includes(`prop=${kind}-connected`)),
		);
	await until(async () =>
		connected(await page.evaluate(() => window.__served)),
	);
	// and a load past the proxy that started late is in the recorder's list
	await sleep(1000);
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === host)
		.map((entry) => entry.url.replace(/^.*\?/, ''));
	ok(
		`${mode}: no URL property a page sets loads past the proxy`,
		raw.length === 0,
		JSON.stringify([...new Set(raw)]),
	);
	const served = await page.evaluate(() => window.__served);
	ok(
		`${mode}: the connected loads go through the worker`,
		connected(served),
		JSON.stringify(served.filter((url) => url.includes('prop=')).length),
	);
	await page.close();
}

// reading the markup back loads nothing: no request at all, through the
// proxy or past it, from innerHTML, outerHTML, getHTML, XMLSerializer, a
// template's or a shadow root's innerHTML (the page's own loads are in before)
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.evaluate(() => {
		window.__served = [];
		window.controller.addEventListener('request', (event) =>
			window.__served.push(event.detail.url),
		);
	});
	await submitLanding(page, `${FIXTURE}pages/property-sets.html?read`);
	// through the worker: each marked load once, the page's own
	const marked = async () => {
		const counts = {};
		for (const url of await page.evaluate(() => window.__served)) {
			const mark = /prop=(read-[\w-]+)/.exec(url)?.[1];
			if (mark) counts[mark] = (counts[mark] ?? 0) + 1;
		}
		return counts;
	};
	// the page reads when it is asked (__readBack), and it is asked once its
	// own loads were served and the recorder listens: no timer of the page's
	// has to be met
	const frame = await frameWhere(
		page,
		() => typeof window.__readBack === 'function',
	);
	await until(async () => {
		const counts = await marked();
		return OWN.every((mark) => counts[mark] >= 1);
	});
	const recorder = await recordRequests(page.context());
	const read =
		(await frame?.evaluate(() => window.__readBack()).catch(() => null)) ??
		null;
	await sleep(1000);
	const during = recorder.log
		.filter((entry) => /prop=read-/.test(entry.url))
		.map((entry) => [entry.kind, entry.url.replace(/^.*prop=/, '')]);
	const counts = await marked();
	ok(
		`${mode}: reading the markup back makes no request at all`,
		read !== null &&
			during.length === 0 &&
			OWN.every((mark) => counts[mark] === 1) &&
			Object.values(counts).every((count) => count <= 1),
		JSON.stringify({ read, during, counts }),
	);
	await page.close();
}
await done(browser);
