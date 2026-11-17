// PresentationRequest.reconnect(id), natively against proxied, both modes.
// The browser joins a presentation of the real origin, which every proxied
// site shares, so through the proxy a site joins only the presentations its
// own documents were handed and any other id is the browser's unknown one.
// No presentation can be started without a display, so what is compared is
// what a page without one sees (test/pages/presentation-reconnect.html):
// each call's rejection and the members' shapes.
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

const PAGE = `${FIXTURE}pages/presentation-reconnect.html`;

async function measure(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames()) {
			const value = await frame
				?.evaluate(() => window.__presentation)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.frames());
await nativePage.close();
ok('natively, the page answered', !!native, JSON.stringify(native));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page
			.frames()
			.filter((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url())),
	);
	for (const key of Object.keys(native ?? {}))
		ok(
			`${mode}: ${key} as natively`,
			proxied?.[key] === native[key],
			`native ${JSON.stringify(native[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	await page.context().close();
}

await done(browser);
