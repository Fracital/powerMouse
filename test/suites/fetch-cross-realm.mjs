// A Request is a Request whichever window made it: fetch, the Request
// constructor and fetchLater take another window's Request (an iframe's, the
// parent's) as the request it is. The fetch hook told requests apart with
// `instanceof`, which sees only its own realm's prototype, and fetched the
// string "[object Request]" resolved against the page (Subscribe with
// Google on washingtonpost.com asked for news.google.com/swg/[object
// Request]). The page (test/pages/fetch-cross-realm.html) hands Requests
// across an iframe both ways; the suite loads it natively and in both demo
// modes and asserts the proxied record is the native one.
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

const target = `${FIXTURE}pages/fetch-cross-realm.html`;
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
	'native: every cross-window request reaches its URL',
	native.frameRequestTopFetch ===
		'200 /pages/fetch-cross-realm.txt cross-realm ok' &&
		native.topRequestFrameFetch === native.frameRequestTopFetch &&
		native.frameRequestTopConstructor === '?c' &&
		native.framePostTopFetch === '200 5' &&
		native.frameRequestWithInit === '200 11',
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
