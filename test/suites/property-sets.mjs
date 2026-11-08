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
await done(browser);
