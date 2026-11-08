// A window keeps its identity when it navigates to another site. A page that
// opened a popup with window.open() and navigated it, or read a frame's
// contentWindow before the frame loaded another site, compares that object
// with a message's event.source: it must be the same object, as it is in the
// browser (WPT fetch-metadata window-location and form-submission hung on
// exactly this). The popup's about:blank reads back as about:blank, not as
// its opener's URL. Every value is compared with the same page loaded
// natively; both demo modes.
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

const target = `${FIXTURE}pages/window-identity.html`;

async function report(page) {
	let value = null;
	for (let i = 0; i < 50 && !value?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				.evaluate(() => window.__identity)
				.catch(() => null);
			if (found) value = found;
		}
	}
	return value;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the popup and the frame are their messages source',
	native?.popup?.source === true && native?.frame?.source === true,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	for (const key of ['popup', 'frame'])
		ok(
			`${mode}: the ${key} that went to another site is its messages' source, as natively`,
			JSON.stringify(proxied?.[key]) === JSON.stringify(native?.[key]),
			JSON.stringify({ native: native?.[key], proxied: proxied?.[key] }),
		);
	ok(
		`${mode}: a popup opened without a URL, and a new frame, read back as about:blank`,
		proxied?.blank === native?.blank &&
			proxied?.frameBlank === native?.frameBlank,
		JSON.stringify({
			native: [native?.blank, native?.frameBlank],
			proxied: [proxied?.blank, proxied?.frameBlank],
		}),
	);
	await page.close();
}
await done(browser);
