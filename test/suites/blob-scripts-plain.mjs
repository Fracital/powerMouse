// A script from a blob that the proxy has nothing to rewrite in runs as the
// classic script it is: a <script src=blob:> and a classic worker, next to a
// module worker. The proxy rewrites a script blob when the page makes it,
// and took one that came back unchanged for one that does not parse as a
// classic script, so it rewrote it again as a module, whose preamble
// (`import.meta.url = ...`) a classic script cannot run. Both modes, against
// the page loaded natively.
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
const PAGE = `${FIXTURE}pages/blob-scripts-plain.html`;
const CASES = ['script', 'classic', 'module'];

async function measure(getFrame) {
	for (let i = 0; i < 60; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__plain?.done ? window.__plain : null))
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
	'natively: every plain blob script runs',
	CASES.every((name) => native[name] === 'ran'),
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
			`${mode}: a ${name} from a plain blob runs as natively`,
			proxied[name] === native[name],
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied[name])} ${proxied.scriptError ?? ''}`,
		);
	await page.close();
}

await done(browser);
