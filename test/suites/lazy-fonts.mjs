// A stylesheet's font faces are fetched only as the text needs them, as
// natively: Chrome fetches a face when text in its unicode-range is shown
// in its family, weight and style. In a document no service worker controls
// (an about:blank frame the page writes into, or one that takes the faces
// from a <style>), the inject copies a stylesheet's loads for it, and it
// copied every url() up front: every subset and weight of a Google Fonts
// sheet. The page (test/pages/lazy-fonts.html) reads the fixture's request
// log around each case; compared with native in both demo modes.
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

const target = `${FIXTURE}pages/lazy-fonts.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';

async function collect(find) {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		const record = await (
			await find()
		)
			?.evaluate(() =>
				window.__record && window.__record.done
					? JSON.stringify(window.__record)
					: null,
			)
			.catch(() => null);
		if (record) return JSON.parse(record);
	}
	return {};
}

const browser = await launch();
const errors = [];

const nativePage = await browser.newPage();
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(target);
const native = await collect(async () => nativePage.mainFrame());
await nativePage.close();

ok(
	'native: only the face the text needs is fetched',
	['page', 'written', 'style', 'asked'].every(
		(name) =>
			native[`${name} fetched`] === 'latin' &&
			native[`${name} drawn`] === 'face',
	) && native['asked load'] === 'loaded',
	show(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await collect(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	for (const key of Object.keys(native).filter((k) => k !== 'done'))
		ok(
			`${mode}: ${key} as native`,
			proxied[key] === native[key],
			`native ${show(native[key])} -> proxied ${show(proxied[key])}`,
		);
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
