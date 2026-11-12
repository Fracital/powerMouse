// A response with two Content-Type values is served with one, so its module
// and service worker scripts count as executable JavaScript. tiktok's CDN
// sends sw.js with "application/javascript, text/javascript" (two headers
// the fetch Headers object joins with ", "), and the worker refused to
// register the service worker for an unsupported MIME type. The worker now
// keeps the first value. Compared with the page loaded natively (Chrome
// takes one of the two), in both demo modes.
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
const PAGE = `${FIXTURE}pages/dup-content-type.html`;

async function read(frame) {
	for (let i = 0; i < 100; i++) {
		const value = await frame()
			?.evaluate(() => window.__dup)
			.catch(() => null);
		if (value?.done) return value;
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await read(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively, the module runs and the service worker registers',
	native?.moduleRan === true && native?.swRegistered === true,
	JSON.stringify(native),
);

const frameOf = (page) =>
	page
		.frames()
		.findLast(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await read(() => frameOf(page));
	ok(
		`${mode}: the served Content-Type is a single value, no comma`,
		typeof proxied?.contentType === 'string' &&
			!proxied.contentType.includes(','),
		JSON.stringify(proxied),
	);
	ok(
		`${mode}: the two-Content-Type module script runs`,
		proxied?.moduleRan === true,
		JSON.stringify(proxied),
	);
	ok(
		`${mode}: the two-Content-Type service worker registers`,
		proxied?.swRegistered === true,
		JSON.stringify(proxied),
	);
	await page.close();
}

await done(browser);
