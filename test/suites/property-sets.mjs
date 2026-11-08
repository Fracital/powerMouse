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
	await sleep(4000);
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
		['script-src', 'link-href', 'img-src', 'iframe-src'].every((kind) =>
			served.some((url) => url.includes(`prop=${kind}-connected`)),
		),
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
	let frame = null;
	for (let i = 0; i < 40 && !frame; i++) {
		await sleep(100);
		for (const f of page.frames())
			if (
				await f
					.evaluate(
						() =>
							window.__readStarted === undefined &&
							!!document.querySelector('template'),
					)
					.catch(() => false)
			)
				frame = f;
	}
	const recorder = await recordRequests(page.context());
	let read = null;
	for (let i = 0; i < 40 && !read; i++) {
		await sleep(100);
		read = await frame?.evaluate(() => window.__read ?? null).catch(() => null);
	}
	await sleep(1000);
	const during = recorder.log
		.filter((entry) => /prop=read-/.test(entry.url))
		.map((entry) => [entry.kind, entry.url.replace(/^.*prop=/, '')]);
	// through the worker: each marked load once, the page's own
	const served = await page.evaluate(() => window.__served);
	const counts = {};
	for (const url of served) {
		const mark = /prop=(read-[\w-]+)/.exec(url)?.[1];
		if (mark) counts[mark] = (counts[mark] ?? 0) + 1;
	}
	ok(
		`${mode}: reading the markup back makes no request at all`,
		read !== null &&
			during.length === 0 &&
			Object.values(counts).every((count) => count <= 1),
		JSON.stringify({ read, during, counts }),
	);
	await page.close();
}
await done(browser);
