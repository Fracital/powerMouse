// An HTTP library that feature-detects the browser's request objects to pick a
// transport (axios 1.x calls this choosing an adapter) must read the same
// native shapes through the proxy as natively, or it concludes it has no
// usable adapter and every request throws. The page (test/pages/fetch-adapter.html)
// runs axios 1.21.1's own adapter-support predicates, records the brand tag of
// each object axios inspects (fetch/Request/Response/Headers/ReadableStream/
// XMLHttpRequest), the adapter axios would select, and a real same-origin
// request through each browser adapter. This suite loads the page natively and
// in both demo modes and asserts the proxied record matches native: the
// predicates and tags are identical, a usable adapter is selected, and the
// requests succeed.
//
// This guards the fetch/Request/Response/Headers/ReadableStream/XHR surface
// (src/inject/modules/Fetch.ts, src/inject/dom/modules/XMLHttpRequest.ts): a
// readback change that altered any of these brands would silently break every
// axios-based site (and any library using the same native-shape detection)
// while pages still rendered.
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

const target = `${FIXTURE}pages/fetch-adapter.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';

/** the page's record, from the given frame, once it has settled */
async function collect(find) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const record = await (
			await find()
		)
			?.evaluate(() =>
				window.__adapterRecord && window.__adapterRecord.done
					? JSON.stringify(window.__adapterRecord)
					: null,
			)
			.catch(() => null);
		if (record) return JSON.parse(record);
	}
	return {};
}

const browser = await launch();
const errors = [];

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const nativePage = await browser.newPage();
	nativePage.on('pageerror', (error) =>
		errors.push(`${mode} native: ${error.message}`),
	);
	await nativePage.goto(target);
	const native = await collect(async () => nativePage.mainFrame());
	await nativePage.close();

	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await collect(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);

	// native itself must detect a usable adapter, or the page is wrong
	ok(
		`${mode}: native detects a usable adapter`,
		native.selected === 'xhr' &&
			native.predicates?.isFetchSupported === true &&
			native.predicates?.supportsResponseStream === true,
		show(native),
	);

	// the heart of it: every native-shape predicate reads the same proxied
	ok(
		`${mode}: axios's adapter-support predicates match native`,
		show(native.predicates) === show(proxied.predicates),
		`native ${show(native.predicates)} -> proxied ${show(proxied.predicates)}`,
	);

	// the brand tag of each object axios inspects matches native
	ok(
		`${mode}: the request-object brand tags match native`,
		show(native.tags) === show(proxied.tags),
		`native ${show(native.tags)} -> proxied ${show(proxied.tags)}`,
	);

	// a usable adapter is selected through the proxy, the same as native
	ok(
		`${mode}: a usable adapter is selected through the proxy`,
		proxied.selected !== null && proxied.selected === native.selected,
		`native ${show(native.selected)} -> proxied ${show(proxied.selected)}`,
	);

	// and both browser adapters actually carry a request through the proxy
	ok(
		`${mode}: the xhr and fetch adapters each complete a request`,
		proxied.fetchStatus === 200 && proxied.xhrStatus === 200,
		`fetch ${show(proxied.fetchStatus)}, xhr ${show(proxied.xhrStatus)}`,
	);

	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
