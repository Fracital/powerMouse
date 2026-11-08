// A response with one malformed header line is read the way Chrome reads it.
// hyper (inside epoxy) refused the whole HTTP/1 response over a line with no
// colon, a NUL, a CR alone or a byte past 0x7E, so the page got an error
// where Chrome skips the line (no colon), splits the line (CR) or keeps the
// value as a byte string, and only a NUL makes it a network error. Each case
// of test/raw-http.mjs is fetched and loaded in a frame, natively and through
// the proxy, and the two are compared: status, body, the x- headers the page
// sees, the frame's document and the cookies the response set (through
// document.cookie). Both demo modes.
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { CASES, startRawHttp } from '../raw-http.mjs';

async function reportOf(page) {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__rawHeaders)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const server = await startRawHttp(0);
const url = `http://127.0.0.1:${server.address().port}/page`;
const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(url);
const native = await reportOf(nativePage);
await nativePage.close();
ok(
	'natively, the page ran every case',
	native?.done &&
		Object.keys(native.cases).length === Object.keys(CASES).length,
	JSON.stringify(native),
);
ok(
	'natively, the clean case is read with its headers and cookies',
	native?.cases.clean.fetch.body === 'body:clean' &&
		native.cases.clean.cookies.length === 2,
	JSON.stringify(native?.cases.clean),
);

const show = (value) => JSON.stringify(value);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, url);
	const proxied = await reportOf(page);
	ok(`${mode}: the page ran every case`, proxied?.done, show(proxied));
	for (const name of Object.keys(CASES)) {
		const want = native?.cases[name];
		const got = proxied?.cases[name];
		ok(
			`${mode}: ${name}: fetch sees what it sees natively (status, body, headers)`,
			show(got?.fetch) === show(want?.fetch),
			show({ native: want?.fetch, proxied: got?.fetch }),
		);
		// a network error shows the browser's own error page natively and the
		// proxy's through it; either way not the site's document
		const frameOk = want?.frame.startsWith('unreadable')
			? typeof got?.frame === 'string' && !got.frame.startsWith('frame:')
			: got?.frame === want?.frame;
		ok(
			`${mode}: ${name}: the frame shows what it shows natively`,
			frameOk,
			show({ native: want?.frame, proxied: got?.frame }),
		);
		ok(
			`${mode}: ${name}: the response sets the cookies it sets natively`,
			show(got?.cookies) === show(want?.cookies),
			show({ native: want?.cookies, proxied: got?.cookies }),
		);
	}
	await page.close();
}
server.close();
await done(browser);
