// The encrypted event's init data (a media's key ids) is the page's only for
// CORS-same-origin media; Chrome gives another origin's media loaded without
// CORS an empty initDataType and no initData. Every route is same-origin to
// the browser, so another site's media gave the page its key ids. The page
// (test/pages/encrypted-media.html) runs natively and through the proxy and
// each case must read as native Chrome reads it.
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
const url = `${FIXTURE}pages/encrypted-media.html`;
const result = async (frame) => {
	for (let i = 0; i < 150; i++) {
		const value = await frame
			?.evaluate(() =>
				window.__encrypted ? window.__encrypted.then((r) => r) : undefined,
			)
			.catch(() => undefined);
		if (value) return value;
		await sleep(300);
	}
	return { failed: 'no result' };
};

const context = await browser.newContext();
const nativePage = await context.newPage();
await nativePage.goto(url);
const native = await result(nativePage.mainFrame());
await context.close();

const page = await openDemo(browser);
await submitLanding(page, url);
await sleep(1000);
const proxied = await result(
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
);

ok(
	'the page ran natively and proxied',
	native.done === true && proxied.done === true,
	JSON.stringify([native, proxied]).slice(0, 600),
);
for (const key of Object.keys(native))
	ok(
		`${key} as native`,
		JSON.stringify(proxied[key]) === JSON.stringify(native[key]),
		`native ${JSON.stringify(native[key])} proxied ${JSON.stringify(proxied[key])}`,
	);

await done(browser, page.errors);
