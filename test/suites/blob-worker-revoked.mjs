// A worker started from a blob: URL the page revokes at once (right after
// `new Worker()`, as pages do) starts as it does natively, classic and
// module: the browser resolves the URL when the Worker is constructed. The
// proxy starts a blob: worker from a bootstrap of its own that imports the
// page's script inside the worker, a moment later: it imports a private
// URL of the Blob the page's URL stood for, so the page's revoke stays
// native and immediate, and the page's own fetch of the revoked URL fails
// as natively. A blob: URL the worker imports itself after the page revoked
// it fails as natively. Both modes, against the page loaded natively.
// And the first load of a Blob a fresh service worker serves, a worker's
// import() of a blob: URL it revoked, fails at once as natively: the
// worker learns whether it reads blob: URLs itself before it asks a realm
// for the bytes (src/server/rewrites.ts learnBlobsReadable), and a Chrome
// worker never hears an ask, which left the import waiting 3 s.
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
const WAIT_PAGE = `${FIXTURE}pages/blob-worker-import-wait.html`;
/** how long the import may take: the ask it waited on was 3 s */
const AT_ONCE_MS = 2000;
const CASES = [
	'classic',
	'module',
	'imports',
	'classicFetch',
	'moduleFetch',
	'classicMessages',
	'moduleMessages',
];

async function measure(getFrame, name = '__revoked') {
	for (let i = 0; i < 60; i++) {
		const report = await getFrame()
			?.evaluate((key) => (window[key]?.done ? window[key] : null), name)
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

const waitNative = await browser.newPage();
await waitNative.goto(WAIT_PAGE);
const nativeWait = await measure(() => waitNative.mainFrame(), '__importWait');
await waitNative.close();
ok(
	"natively: a worker's import() of a blob: URL it revoked fails at once",
	nativeWait.result === 'failed' && nativeWait.ms < AT_ONCE_MS,
	JSON.stringify(nativeWait),
);

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
	// (first, in a service worker that has served no Blob yet)
	const waitPage = await openDemo(browser, base);
	await submitLanding(waitPage, WAIT_PAGE);
	const wait = await measure(() => frameOf(waitPage), '__importWait');
	ok(
		`${mode}: the first Blob a service worker serves, a worker's import() of a blob: URL it revoked, fails at once as natively`,
		wait.result === nativeWait.result && wait.ms < AT_ONCE_MS,
		`native ${JSON.stringify(nativeWait)} proxied ${JSON.stringify(wait)}`,
	);
	await waitPage.close();
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
