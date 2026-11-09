// The Storage Access API in a frame of another site answers as natively:
// document.hasStorageAccess(), and requestStorageAccess() without and with
// user activation. Every proxied frame is the proxy origin's to the browser,
// and the host's frame sandbox had no allow-storage-access-by-user-activation,
// so requestStorageAccess was refused for the sandbox ("The document is
// sandboxed"). Both modes, against the page loaded natively.
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
const CROSS = `http://localhost:${fixture.port}/pages/storage-access.html`;
const PAGE = `${FIXTURE}pages/storage-access.html?child=${encodeURIComponent(CROSS)}`;

async function measure(page, getFrame) {
	let report = null;
	for (let i = 0; i < 40 && !report?.request; i++) {
		await sleep(250);
		report = await getFrame()
			?.evaluate(() => window.__storageAccess)
			.catch(() => null);
	}
	// the child's button, clicked by the user
	const child = page
		.frames()
		.find((f) => f.parentFrame() && f.parentFrame() === getFrame());
	await child?.click('#request').catch(() => {});
	for (let i = 0; i < 40 && !report?.requestActivated; i++) {
		await sleep(250);
		report = await getFrame()
			?.evaluate(() => window.__storageAccess)
			.catch(() => null);
	}
	return report;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(nativePage, () => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: the frame answered',
	!!native?.requestActivated,
	JSON.stringify(native),
);

const frameOf = (page) =>
	page
		.frames()
		.findLast(
			(f) => /\/stomp\/[\w-]+\/html\//.test(f.url()) && !/nested/.test(f.url()),
		);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(page, () => frameOf(page));
	for (const key of ['has', 'request', 'requestActivated', 'hasAfter'])
		ok(
			`${mode}: ${key} as natively`,
			proxied?.[key] === native?.[key],
			`native ${JSON.stringify(native?.[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	await page.close();
}

await done(browser);
