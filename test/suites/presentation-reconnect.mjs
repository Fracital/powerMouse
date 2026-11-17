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
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/presentation-reconnect.html`;

const TAG = 'presentation-reconnect ';

/**
 * The report the fixture logs, from any frame of `page`: polling it with
 * evaluate() would hand the frame a user gesture each time (Playwright
 * evaluates with one), and start() answers by whether the page has one
 */
const reported = (page) =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), 30000);
		page.on('console', (message) => {
			const text = message.text();
			if (!text.startsWith(TAG)) return;
			clearTimeout(timer);
			resolve(JSON.parse(text.slice(TAG.length)));
		});
	});

const browser = await launch();
const nativePage = await browser.newPage();
const nativeReport = reported(nativePage);
await nativePage.goto(PAGE);
const native = await nativeReport;
await nativePage.close();
ok('natively, the page answered', !!native, JSON.stringify(native));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const report = reported(page);
	await submitLanding(page, PAGE);
	const proxied = await report;
	for (const key of Object.keys(native ?? {}))
		ok(
			`${mode}: ${key} as natively`,
			proxied?.[key] === native[key],
			`native ${JSON.stringify(native[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	await page.context().close();
}

await done(browser);
