// A worker started from a blob: URL the page revokes at once (right after
// `new Worker()`, as pages do) starts as it does natively, classic and
// module: the browser resolves the URL when the Worker is constructed. The
// proxy starts a blob: worker from a bootstrap of its own that imports the
// page's script inside the worker, a moment later: it imports a private
// URL of the Blob the page's URL stood for, so the page's revoke stays
// native and immediate, and the page's own fetch of the revoked URL fails
// as natively. A blob: URL the worker imports itself after the page revoked
// it fails as natively. Both modes, against the page loaded natively.
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
const PAGE = `${FIXTURE}pages/blob-worker-revoked.html`;
const CASES = [
	'classic',
	'module',
	'imports',
	'classicFetch',
	'moduleFetch',
	'classicMessages',
	'moduleMessages',
];

async function measure(getFrame) {
	for (let i = 0; i < 60; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__revoked?.done ? window.__revoked : null))
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return {};
}
/** a worker that failed reports its failure only: the message differs between realms */
const verdict = (value) =>
	typeof value === 'string' && value.startsWith('error')
		? 'error'
		: JSON.stringify(value);

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: the revoked-at-once workers start',
	native.classic === 'ran' && native.module === 'ran',
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
			name.endsWith('Fetch')
				? `${mode}: the page's fetch of a revoked URL a ${name.slice(0, -5)} worker started from fares as natively`
				: name.endsWith('Messages')
					? `${mode}: a ${name.slice(0, -8)} worker's messages reach the page as natively (a capturing listener too)`
					: `${mode}: a ${name} worker from a revoked blob: URL fares as natively`,
			verdict(proxied[name]) === verdict(native[name]),
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied[name])}`,
		);
	await page.close();
}

await done(browser);
