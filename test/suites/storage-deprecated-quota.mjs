// navigator.webkitTemporaryStorage and webkitPersistentStorage
// (DeprecatedStorageQuota), natively against proxied, both modes: what
// queryUsageAndQuota and requestQuota check, when they call back and with
// what, and how far the usage they report grows when the page stores a
// cache entry (test/pages/storage-deprecated-quota.html). Natively both
// report what navigator.storage.estimate() does, the origin's usage and
// quota; the browser's answer through the proxy is the proxy origin's,
// every proxied site's stores and STomp's own counted together.
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

const PAGE = `${FIXTURE}pages/storage-deprecated-quota.html`;

async function measure(frames) {
	for (let i = 0; i < 120; i++) {
		for (const frame of frames()) {
			const value = await frame
				?.evaluate(() => window.__quota)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const context = await browser.newContext();
const nativePage = await context.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.frames());
await context.close();
ok(
	'natively, the page measured both',
	native && !native.failed && native.growth === 'about 300 KB',
	JSON.stringify(native),
);

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
	ok(`${mode}: the page measured both`, !!proxied, JSON.stringify(proxied));
	for (const key of Object.keys(native ?? {}))
		ok(
			`${mode}: ${key} as natively`,
			JSON.stringify(proxied?.[key]) === JSON.stringify(native[key]),
			`native ${JSON.stringify(native[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	await page.context().close();
}

await done(browser);
