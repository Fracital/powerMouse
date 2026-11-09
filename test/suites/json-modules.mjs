// A module that is no script loads as what it is: a JSON module imported
// statically and dynamically (`with { type: 'json' }`) and a CSS module
// (`with { type: 'css' }`). Every import was routed as a module script and
// rewritten, so a JSON module's body came back with the module preamble
// (`import.meta.url = ...`) and failed to parse. A JSON file imported
// without the attribute fails, as natively. Both modes, against the page
// loaded natively.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/json-modules.html`;
const CASES = ['static', 'staticList', 'dynamic', 'noAttribute', 'css'];

async function measure(getFrame) {
	for (let i = 0; i < 60; i++) {
		const report = await getFrame()
			?.evaluate(() => window.__json ?? null)
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return {};
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: the JSON and CSS modules load, a JSON file without the attribute does not',
	native.static === 42 &&
		native.staticList === 3 &&
		native.dynamic === 42 &&
		native.noAttribute === 'error' &&
		native.css === 1,
	JSON.stringify(native),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => frameOf(page));
	for (const name of CASES)
		ok(
			`${mode}: the ${name} import fares as natively`,
			proxied[name] === native[name],
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied[name])}`,
		);
	await page.close();
}

await done(browser);
