// The Origin API (Origin.from and its comparisons) on the platform objects
// it extracts an origin from: under the proxy their internal slots hold the
// proxy's origin, so a cross-site sender compared same-origin and another
// site's window gave an origin. test/pages/origin-api.html runs natively and
// proxied and every answer must be native Chrome's (a browser without the
// API reports that and checks nothing more).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const URL_ = `${FIXTURE}pages/origin-api.html`;
const result = async (frame) => {
	for (let i = 0; i < 100; i++) {
		const value = await frame
			?.evaluate(() =>
				window.__origin ? window.__origin.then((r) => r) : undefined,
			)
			.catch(() => undefined);
		if (value) return value;
		await sleep(300);
	}
	return { failed: 'no result' };
};

const context = await browser.newContext();
const nativePage = await context.newPage();
await nativePage.goto(URL_);
const native = await result(nativePage.mainFrame());
await context.close();

const page = await openDemo(browser);
await submitLanding(page, URL_);
await sleep(1000);
const proxied = await result(
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
);

ok(
	'the page ran natively and proxied',
	native?.done === true && proxied?.done === true,
	JSON.stringify([native, proxied]).slice(0, 600),
);
for (const key of Object.keys(native ?? {}))
	ok(
		`${key} as native`,
		JSON.stringify(proxied?.[key]) === JSON.stringify(native[key]),
		`native ${JSON.stringify(native[key])} proxied ${JSON.stringify(proxied?.[key])}`,
	);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
