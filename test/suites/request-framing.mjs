// A request body whose length the page's API knows (a string, an empty
// string, a Blob, a buffer, URLSearchParams, FormData; from fetch, XHR and
// sendBeacon) reaches the server with the Content-Length the browser sends
// natively, never as a chunked upload: servers that refuse chunked request
// bodies answer 411 Length Required (Bing's API endpoints did, every one).
// Compared with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/request-framing.html`;
const NAMES = [
	'string',
	'empty',
	'blob',
	'buffer',
	'params',
	'form',
	'put',
	'xhr',
	'beacon',
];

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__framing)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, every body arrives with a Content-Length and none chunked',
	!!native &&
		native.error === undefined &&
		NAMES.every(
			(name) => native[name]?.length !== null && !native[name]?.chunked,
		),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: every request completes`,
		!!proxied && proxied.error === undefined,
		JSON.stringify(proxied?.error ?? proxied),
	);
	for (const name of NAMES)
		ok(
			`${mode}: the ${name} body is framed as natively`,
			JSON.stringify(proxied?.[name]) === JSON.stringify(native?.[name]),
			JSON.stringify({ native: native?.[name], proxied: proxied?.[name] }),
		);
	await page.close();
}
await done(browser);
