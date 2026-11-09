// A worker the page terminates a moment after starting it reports nothing,
// as natively: Cloudflare's challenge (Stack Overflow) starts a blob: worker
// and terminates it at once, and through the proxy the worker was by then in
// the middle of importing the proxy's own bundle (or the private URL of the
// page's blob). Chrome reports an import a terminated worker lost as an error
// event on the Worker, so the page saw "importScripts ... failed to load"
// naming a proxy URL and the challenge threw. An import of the worker's own
// that termination cuts off still reports, as natively. Both modes, against
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
const PAGE = `${FIXTURE}pages/worker-terminated.html`;

async function measure(getFrame) {
	for (let i = 0; i < 80; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__terminated?.done ? window.__terminated : null))
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
	'natively: terminated workers that import nothing report no error',
	native.errors === 0,
	JSON.stringify(native),
);
ok(
	'natively: a worker terminated during an import of its own reports it',
	typeof native.ownImport === 'string',
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
	ok(
		`${mode}: terminated workers that import nothing report no error`,
		proxied.errors === 0,
		JSON.stringify(proxied),
	);
	ok(
		`${mode}: a worker terminated during an import of its own reports it`,
		typeof proxied.ownImport === 'string',
		JSON.stringify(proxied),
	);
	await page.close();
}

await done(browser);
