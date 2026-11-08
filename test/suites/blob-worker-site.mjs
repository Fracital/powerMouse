// A blob: worker's requests are judged as the page that made it, as the
// browser does: an importScripts and a fetch to another site carry
// Sec-Fetch-Site cross-site and, with the default credentials
// (same-origin), no cookie; a fetch to the page's own origin is
// same-origin and carries its SameSite=Strict cookie. The worker cannot
// decode a blob: URL to a page, so the page tells it which blob: URLs it
// minted. Both modes, each request compared with the page loaded natively.
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

/** what each of the worker's requests showed: its site, and whether the Strict cookie went */
async function measure(getFrame, key) {
	let result = null;
	for (let i = 0; i < 80 && !result; i++) {
		await sleep(250);
		result = await getFrame()
			?.evaluate(() => window.__blobSite ?? null)
			.catch(() => null);
	}
	const imported = await (
		await fetch(`${FIXTURE}echo-headers/recorded?k=${key}-import`)
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
	await page.close();
}

await done(browser);
