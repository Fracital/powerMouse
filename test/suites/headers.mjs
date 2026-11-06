// Response headers that would bind the page to the proxy origin (HSTS,
// COEP, reporting, Set-Cookie, Clear-Site-Data) are stripped, Link and
// Content-Location are rewritten, and the request headers the proxy sends
// follow the browser's defaults: Origin and `strict-origin-when-cross-origin`
// referrers for cross-origin fetches, fetch metadata computed from the real
// origins.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const other = FIXTURE.replace('127.0.0.1', 'localhost');
const origin = new URL(FIXTURE).origin;

async function load(url, key) {
	await page.click('#home');
	await submitLanding(page, url);
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => f.url().includes('/stomp/html/'));
		try {
			const value = await frame.evaluate((k) => window[k], key);
			if (value && (value.done || typeof value === 'string')) return value;
		} catch (error) {
			// navigating
		}
	}
	return null;
}

const hdr = (await load(`${FIXTURE}pages/headers.html`, '__hdr')) || {};
const response = hdr.response || {};
ok('fetch completed', hdr.error === undefined, JSON.stringify(hdr.error));
for (const name of [
	'strict-transport-security',
	'cross-origin-embedder-policy',
	'report-to',
	'nel',
	'permissions-policy',
	'x-content-type-options',
	'set-cookie',
])
	ok(
		`${name} is stripped`,
		!(name in response),
		JSON.stringify(response[name]),
	);
ok(
	'a custom header is kept',
	response['x-custom'] === 'kept',
	JSON.stringify(response['x-custom']),
);
ok(
	'Link header URLs are rewritten',
	/\/stomp\/css\//.test(response.link || '') &&
		/\/stomp\/js:genericModule\//.test(response.link || ''),
	JSON.stringify(response.link),
);
ok(
	'Content-Location is rewritten',
	/\/stomp\//.test(response['content-location'] || ''),
	JSON.stringify(response['content-location']),
);
const same = hdr.same || {};
const cross = hdr.cross || {};
ok(
	'same-origin fetch: full referrer, no Origin',
	same.referer === `${FIXTURE}pages/headers.html` && same.origin === undefined,
	JSON.stringify([same.referer, same.origin]),
);
ok(
	'cross-origin fetch: Origin set, referrer reduced to the origin',
	cross.origin === origin && cross.referer === `${origin}/`,
	JSON.stringify([cross.origin, cross.referer]),
);
ok(
	'fetch metadata is computed from the real origins',
	same['sec-fetch-site'] === 'same-origin' &&
		cross['sec-fetch-site'] === 'cross-site' &&
		cross['sec-fetch-mode'] === 'cors' &&
		cross['sec-fetch-dest'] === 'empty',
	JSON.stringify([
		same['sec-fetch-site'],
		cross['sec-fetch-site'],
		cross['sec-fetch-mode'],
		cross['sec-fetch-dest'],
	]),
);

// Clear-Site-Data from one proxied origin must not wipe another's storage
await load(`${FIXTURE}pages/keep.html#set`, '__keep');
await load(`${other}pages/csd.html`, 'document');
await sleep(1000);
const kept = await load(`${FIXTURE}pages/keep.html#get`, '__keep');
ok(
	'Clear-Site-Data on another origin leaves this origin storage alone',
	kept === 'yes',
	JSON.stringify(kept),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
