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
// never ran (changes/request-body-absent.md). A frame's own reads
// (localStorage, document.cookie) there reached their 10 s limit and threw a
// RangeError: the frame held no part to ask with
// (changes/firefox-frame-sync-reads.md). WebKit stops a page's
// worker while the page waits (src/server/syncFrozen.ts), so no answer of
// the bridge came at all: a request there came back with status 0 after
// 30 s, localStorage and document.cookie threw a RangeError after 10 s,
// and the scripts of the about:blank frame never ran
// (changes/webkit-sync-bridge.md).
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

// Differences known and left, by engine, mode and case, with why. One
// that now reads as natively fails too: take it off.
const KNOWN = {};

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
