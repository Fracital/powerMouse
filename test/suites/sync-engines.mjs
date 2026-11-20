// What a page asks of the browser synchronously, in Chrome, WebKit and
// Firefox (test/engines.mjs): a synchronous XMLHttpRequest, localStorage,
// document.cookie, and classic external scripts in an about:blank frame the
// page writes and in an about:srcdoc frame (test/pages/sync-engines.html).
// Through the proxy each goes through the synchronous bridge
// (src/inject/dom/modules/Sync.ts), whose answer Firefox shows a spinning
// page only in the answer to a synchronous request of its own
// (src/inject/dom/syncAnswer.ts): before, a request there took 30 s and
// came back with status 0, localStorage 10 s, and each script of a srcdoc
// frame (which no service worker controls in Firefox under the proxy's
// sandboxed frame, as natively) 5 s. Every case must read what it reads
// natively, in time, in both modes. The first proxied document of a tab
// there often had a Request with no body getter (as a fresh profile's first
// page has natively), which the bundle read as it loaded: such a document
// never ran (changes/request-body-absent.md).
import { proxiedGo, withFirefox, withWebKit } from '../engines.mjs';
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

const URL_OF = `${FIXTURE}pages/sync-engines.html`;
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];
const REPORT = 'window.__seReport';

// Differences known and left, by engine, mode and case, with why. One that
// now reads as natively fails too: take it off.
const WEBKIT_BRIDGE =
	"WebKit sends a page's synchronous request past its worker, to the network, and a cookie the worker sets with cookieStore.set lands only once the page's spin ends (both measured natively in WebKitGTK 2.52.4), so no answer of the bridge reaches a page that waits on it (open: a way for WebKit's answers)";
const KNOWN = Object.fromEntries(
	['same-origin', 'isolated'].flatMap((mode) =>
		['syncXhr', 'localStorage', 'cookie', 'written'].map((name) => [
			`WebKit ${mode}: ${name}`,
			WEBKIT_BRIDGE,
		]),
	),
);

function compare(engine, mode, want, got) {
	for (const name of new Set([
		...Object.keys(want ?? {}),
		...Object.keys(got ?? {}),
	])) {
		const a = JSON.stringify(want?.[name]);
		const b = JSON.stringify(got?.[name]);
		const detail = `native ${a}, proxied ${b}`;
		const label = `${engine} ${mode}: ${name}`;
		const known = KNOWN[label];
		if (known && a !== b)
			ok(`${label} differs, a known difference: ${known}`, true, detail);
		else if (known)
			ok(
				`${label} reads as natively: take it off the known list`,
				false,
				detail,
			);
		else ok(`${label} reads as natively, in time`, a === b, detail);
	}
}

// ---- Chrome ----

const browser = await launch();

async function chromeReport(page) {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(REPORT).catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(URL_OF);
const want = await chromeReport(nativePage);
await nativePage.context().close();
ok('Chrome natively, the page reported', want !== null, JSON.stringify(want));
for (const [mode, base] of MODES) {
	const page = await openDemo(browser, base);
	await submitLanding(page, URL_OF);
	compare('Chrome', mode, want, await chromeReport(page));
	await page.context().close();
}

// ---- WebKit and Firefox ----

async function compareEngine(engine, open) {
	const session = await open();
	let native;
	try {
		await session.go(URL_OF);
		native = await session.report();
	} finally {
		await session.close();
	}
	ok(
		`${engine} natively, the page reported`,
		native && typeof native === 'object',
		JSON.stringify(native),
	);
	for (const [mode, base] of MODES) {
		const proxied = await open();
		let got;
		try {
			await proxiedGo(proxied, base, URL_OF);
			got = await proxied.report();
		} finally {
			await proxied.close();
		}
		compare(engine, mode, native, got);
	}
}

await withWebKit('sync-engines', REPORT, (open) =>
	compareEngine('WebKit', open),
);
await withFirefox('sync-engines', REPORT, (open) =>
	compareEngine('Firefox', open),
);

await done(browser);
