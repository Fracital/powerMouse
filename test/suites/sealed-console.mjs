// An image of another site in an about:blank frame the page wrote loads with
// nothing said in the console, as natively. The proxy copies such a load
// (no service worker controls the frame) and seals the copy's URL: made in
// a worker it then terminates, so nothing can fetch it, and handed over
// once a fetch of a second URL that worker made fails. That fetch was the
// page's own, and Chrome reported each one in the page's console as
// "Failed to load resource: net::ERR_FILE_NOT_FOUND" (chase.com showed four
// a load); it is asked of a worker now, whose failed fetch Chrome does not
// report. Both modes, against the page loaded natively.
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
const other = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const PAGE = `${FIXTURE}pages/sealed-console.html?b=${encodeURIComponent(other)}`;

async function measure(getFrame) {
	for (let i = 0; i < 80; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__sealed?.done ? window.__sealed : null))
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return {};
}
/** the network errors the console shows, by the URL they name */
const consoleOf = (page) => {
	const said = [];
	page.on('console', (message) => {
		const text = message.text();
		if (/Failed to load resource/.test(text))
			said.push(`${text} ${message.location()?.url ?? ''}`);
	});
	return said;
};

const nativePage = await browser.newPage();
const nativeSaid = consoleOf(nativePage);
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: every image of the other site loads',
	native.images?.length === 9 && native.images.every((r) => r === 'load 1'),
	JSON.stringify(native),
);
ok(
	'natively: nothing in the console',
	!nativeSaid.length,
	nativeSaid.join('\n'),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const said = consoleOf(page);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => frameOf(page));
	ok(
		`${mode}: every image of the other site in the written frame loads as natively`,
		JSON.stringify(proxied.images) === JSON.stringify(native.images),
		`native ${JSON.stringify(native.images)} proxied ${JSON.stringify(proxied.images)} (ms a burst: native ${native.ms} proxied ${proxied.ms})`,
	);
	ok(
		`${mode}: the console says nothing of the copies' blob: URLs, as natively`,
		!said.some((line) => line.includes('blob:')),
		said.join('\n'),
	);
	await page.close();
}

await done(browser);
