// Response headers that would bind the page to the proxy origin (HSTS,
// COEP, reporting, Set-Cookie, Clear-Site-Data) are stripped, Link and
// Content-Location are rewritten, and the request headers the proxy sends
// follow the browser's defaults: Origin and `strict-origin-when-cross-origin`
// referrers for cross-origin fetches, fetch metadata computed from the real
// origins.
import { networkInterfaces } from 'node:os';
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
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
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
	/\/stomp\/[\w-]+\/css\//.test(response.link || '') &&
		/\/stomp\/[\w-]+\/js:genericModule\//.test(response.link || ''),
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

// Fetch metadata, request kind by request kind, against what the same page
// sends natively: the fixture keeps each request's headers by key. A
// top-level navigation is the one the user starts (the omnibox natively,
// the host's landing through the proxy). The LAN address is an http origin
// that is not potentially trustworthy, which gets no Sec-Fetch-* at all (the
// suites' resolver rules keep the native page from reaching it, so only the
// proxied request is checked)
const METADATA = [
	'sec-fetch-site',
	'sec-fetch-mode',
	'sec-fetch-dest',
	'sec-fetch-user',
];
const lanAddress = Object.values(networkInterfaces())
	.flat()
	.find((a) => a.family === 'IPv4' && !a.internal)?.address;
const lan = lanAddress && `http://${lanAddress}:${new URL(FIXTURE).port}`;
const recorded = async (key) => {
	for (let i = 0; i < 40; i++) {
		const headers = await (
			await fetch(`${FIXTURE}echo-headers/recorded?k=${key}`)
		).json();
		if (headers) return headers;
		await sleep(250);
	}
	return null;
};
const metadataPage = (run) =>
	`${FIXTURE}pages/fetch-metadata.html?run=${run}${lan ? `&lan=${encodeURIComponent(lan)}` : ''}`;

const nativePage = await browser.newPage();
await nativePage.goto(metadataPage('native'));
await nativePage
	.waitForFunction(() => window.__fm?.done, null, { timeout: 30000 })
	.catch(() => {});
await nativePage.goto(`${FIXTURE}echo-headers?k=native-top`);
await nativePage.close();
const proxied = (await load(metadataPage('proxied'), '__fm')) || {};
ok(
	'the fetch metadata page ran through the proxy',
	proxied.done === true && !proxied.errors,
	JSON.stringify(proxied),
);
await page.click('#home');
await submitLanding(page, `${FIXTURE}echo-headers?k=proxied-top`);

// Sec-Fetch-User of a navigation a page starts follows the page's user
// activation, which the browser never tells the service worker (and the
// native page has it from the harness's navigation); only the user's own
// top-level navigation is compared for it
for (const [key, what] of [
	['fetch-same', 'a same-origin fetch'],
	['fetch-cross-cors', 'a cross-site fetch'],
	['fetch-cross-no-cors', 'a cross-site no-cors fetch'],
	['fetch-redirect', 'a no-cors fetch redirected from cross-site'],
	['img', 'a cross-site image'],
	['script', 'a cross-site script'],
	['script-cors', 'a cross-site crossorigin script'],
	['iframe', 'a same-origin iframe document'],
	['iframe-cross', 'a cross-site iframe document'],
	['nested-fetch', "a cross-site frame's fetch to its own origin"],
	['top', 'a top-level navigation the user started'],
]) {
	const native = await recorded(`native-${key}`);
	const through = await recorded(`proxied-${key}`);
	const compared = key.startsWith('iframe')
		? METADATA.filter((h) => h !== 'sec-fetch-user')
		: METADATA;
	const pick = (headers) =>
		headers && Object.fromEntries(METADATA.map((h) => [h, headers[h]]));
	ok(
		`fetch metadata of ${what} matches the native request`,
		native !== null &&
			through !== null &&
			compared.every((h) => native[h] === through[h]),
		JSON.stringify({ native: pick(native), proxied: pick(through) }),
	);
}
if (lan) {
	const through = await recorded('proxied-lan');
	ok(
		'a non-trustworthy http origin gets no fetch metadata',
		through !== null && METADATA.every((h) => !(h in through)),
		JSON.stringify(through),
	);
} else
	console.log('no LAN address: the non-trustworthy origin check is skipped');

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
