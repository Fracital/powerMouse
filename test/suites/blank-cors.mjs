// A document no service worker controls (a frame's initial about:blank,
// where ad and widget code writes its markup) loads its subresources as
// copies the inject fetches for it. Each copy is sent as the load it stands
// for, and a CORS load (a stylesheet's font face, a crossorigin=anonymous
// image or script) sends credentials to its own origin only, as natively:
// the copies were sent with credentials, so an answer that allows any origin
// (`Access-Control-Allow-Origin: *`, Google Fonts' and most CDNs') failed
// its CORS check and the font, image or script never loaded (target.com: 54
// Google Fonts requests refused in one frame). The page
// (test/pages/blank-cors.html) loads one of each from another origin into an
// about:blank frame; the suite compares the proxied record with native in
// both demo modes.
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

const target = `${FIXTURE}pages/blank-cors.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';

async function collect(find) {
	for (let i = 0; i < 160; i++) {
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
	'native: the font, image and script load',
	native.sheet === 'load' &&
		native.font === 'loaded' &&
		native.image === 'load 3' &&
		native.script === 'load ran',
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
