// An XML document keeps its encoding through the proxy. The worker served
// every XML shell as UTF-8, so document.characterSet read UTF-8 where Chrome
// reads what a byte order mark, the Content-Type charset or the XML
// declaration names (web-platform-tests encoding/utf-32.html: a UTF-32LE
// byte order mark is a UTF-16LE one). Each fixture records its
// characterSet, its text and its root's attribute, natively and through the
// proxy in both demo modes; a meta of an XHTML page names nothing, and a
// declaration of UTF-16 in an 8-bit document reads as natively.
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
const FILES = ['utf16le', 'utf16be', 'decl1252', 'header', 'meta', 'decl16'];
const url = (name) => `${FIXTURE}pages/xml-encoding-${name}.bin`;

/** what the document recorded, from the newest frame that recorded it */
async function read(page, proxied) {
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames.reverse()) {
			const value = await frame
				.evaluate(() => window.__xmlEncoding ?? null)
				.catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

const native = {};
for (const name of FILES) {
	const page = await browser.newPage();
	await page.goto(url(name), { waitUntil: 'commit' });
	native[name] = await read(page, false);
	await page.close();
}
ok(
	'natively, every XML fixture reported',
	FILES.every((name) => native[name]?.characterSet),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const name of FILES) {
		const page = await openDemo(browser, base);
		await submitLanding(page, url(name));
		const proxied = await read(page, true);
		ok(
			`${mode}: ${name} reads its encoding, text and attribute as natively (${JSON.stringify(native[name])})`,
			JSON.stringify(proxied) === JSON.stringify(native[name]),
			JSON.stringify(proxied),
		);
		await page.context().close();
	}
}
await done(browser);
