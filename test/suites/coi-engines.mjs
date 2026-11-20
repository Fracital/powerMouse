// Cross-origin isolation through the proxy in more than Chrome
// (docs/same-origin-policy.md, "Cross-origin isolation"). Engines differ
// (src/isolation.ts IsolationEngine): a page that sends COOP same-origin
// and COEP require-corp is isolated in every browser with an embedder
// policy; one with COEP credentialless only where the browser has that
// value (Chrome and Firefox, not WebKit); a frame of an isolated page that
// gives up the `cross-origin-isolated` permission, or that is of another
// origin, is not isolated in Chrome and is in Firefox and WebKit, which
// have no such permission; a Document-Isolation-Policy isolates only in
// Chrome; a credentialless frame is Chrome's alone. The host's page and
// what the service worker serves say `require-corp`, which every one of them
// honours, and the service worker decides each document by the rules of the
// browser it runs in, which the controller's document asks the browser
// (src/controller/isolationProbe.ts).
//
// Each kind of page (test/pages/coi-engines.js) reports what it, its
// worker, a blob: worker of it (classic and module) and (one kind) its
// frames read of `crossOriginIsolated` and SharedArrayBuffer, and whether a
// blob: script of it ran, a blob: module's static import of another blob:
// module and a frame of a blob: document, and (one kind) who reaches an
// about:blank it navigates a frame of another origin's frame to (itself in
// Chrome and Firefox, that frame in WebKit; test/pages/coi-engines.js) and
// what that document reaches itself, natively and through the demo in both
// modes, and every part must read as natively:
// - in Chrome, always, with the embedder policy the host's page and a
//   proxied document were served with;
// - in WebKit (WebKitGTK's MiniBrowser driven by WebKitWebDriver, in a
//   headless weston of the suite's own), where those are installed;
//   WEBKIT_MINIBROWSER names another MiniBrowser;
// - in Firefox (headless, over WebDriver BiDi), where it is installed and
//   not on CI; FIREFOX names another binary.
// A part that cannot run says SKIP. A difference left is on KNOWN, with why.
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

const COOP = 'cross-origin-opener-policy:same-origin';
const OTHER = FIXTURE.replace('127.0.0.1', 'localhost').replace(/\/$/, '');
const KINDS = {
	// (and its frames: test/pages/coi-engines.js FRAMES)
	'COOP and COEP require-corp': {
		headers: [COOP, 'cross-origin-embedder-policy:require-corp'],
		frames: true,
	},
	'COOP and COEP credentialless': {
		headers: [COOP, 'cross-origin-embedder-policy:credentialless'],
	},
	'no headers': { headers: [] },
	'Document-Isolation-Policy isolate-and-require-corp': {
		headers: ['document-isolation-policy:isolate-and-require-corp'],
	},
};
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

let run = 0;
const pageURL = ({ headers, frames }) =>
	`${FIXTURE}coi/doc?script=/pages/coi-engines.js&k=e${++run}${headers
		.map((header) => `&h=${encodeURIComponent(header)}`)
		.join('')}${frames ? `&frames=${encodeURIComponent(OTHER)}` : ''}`;

/** a report's parts, by name: the page, its workers, each of its frames' */
const parts = (report) => {
	const named = new Map();
	const add = (prefix, of) => {
		for (const part of [
			'page',
			'worker',
			'blobWorker',
			'blobModuleWorker',
			'blobScript',
			'blobImport',
			'blobDocument',
			'blankNavigated',
		])
			named.set(`${prefix}${part}`, of?.[part]);
	};
	add('', report);
	for (const [name, frame] of Object.entries(report?.frames ?? {}))
		if (typeof frame === 'object' && frame) add(`frame ${name}: `, frame);
		else named.set(`frame ${name}`, frame);
	return named;
};

// Differences known and left, by engine, mode and part (a part's name ends
// with it), with why. One that now reads as natively fails too: take it off.
// (none left: a blob: worker of a frame of another site's page started in
// Firefox and WebKit once the page hands its Blob's bytes to the service
// worker, which cannot read that blob: URL there)
const KNOWN = {};

/** every part of what a page read through the proxy reads as it did natively */
function compare(engine, mode, kind, want, got) {
	const wanted = parts(want);
	const gotten = parts(got);
	for (const part of new Set([...wanted.keys(), ...gotten.keys()])) {
		const a = JSON.stringify(wanted.get(part));
		const b = JSON.stringify(gotten.get(part));
		const detail = `native ${a}, proxied ${b}`;
		const label = `${engine} ${mode}: ${kind}: ${part}`;
		const known = Object.entries(KNOWN[engine] ?? {}).find(
			([at]) =>
				at.startsWith(`${mode}: `) && part.endsWith(at.slice(mode.length + 2)),
		)?.[1];
		if (known && a !== b)
			ok(`${label} differs, a known difference: ${known}`, true, detail);
		else if (known)
			ok(
				`${label} reads as natively: take it off the known list`,
				false,
				detail,
			);
		else ok(`${label} reads as natively`, a === b, detail);
	}
}

// ---- Chrome ----

const browser = await launch();

async function chromeReport(page) {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__coiEngine)
				.catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

for (const [mode, base] of MODES) {
	const host = await fetch(base);
	ok(
		`${mode}: the host's page is served with COEP require-corp, which WebKit honours too`,
		host.headers.get('cross-origin-embedder-policy') === 'require-corp',
		host.headers.get('cross-origin-embedder-policy'),
	);
}

for (const [name, kind] of Object.entries(KINDS)) {
	const nativePage = await browser.newPage();
	await nativePage.goto(pageURL(kind));
	const want = await chromeReport(nativePage);
	await nativePage.context().close();
	ok(
		`Chrome natively, a page with ${name} reported`,
		want !== null,
		JSON.stringify(want),
	);
	for (const [mode, base] of MODES) {
		const page = await openDemo(browser, base);
		const served = [];
		page.on('response', (response) => {
			if (response.request().resourceType() === 'document')
				served.push(response);
		});
		await submitLanding(page, pageURL(kind));
		const got = await chromeReport(page);
		compare('Chrome', mode, name, want, got);
		const proxied = served.find((response) => /\/html\//.test(response.url()));
		const policy = proxied
			? await proxied.headerValue('cross-origin-embedder-policy')
			: null;
		ok(
			`Chrome ${mode}: the proxied document of a page with ${name} is served with COEP require-corp`,
			policy === 'require-corp',
			policy,
		);
		await page.context().close();
	}
}

const REPORT = 'window.__coiEngine';

/**
 * Every kind natively and through the demo in both modes, in a browser
 * `session` opens: `{ go(url), evaluate(expression), report() }`, closed by
 * `close()`
 */
async function compareEngine(engine, open) {
	for (const [mode, base] of MODES) {
		const session = await open();
		try {
			await session.go(base);
			const host = await session.evaluate('self.crossOriginIsolated');
			ok(
				`${engine} ${mode}: the host's page is cross-origin isolated`,
				host === true,
				host,
			);
		} finally {
			await session.close();
		}
	}
	for (const [name, kind] of Object.entries(KINDS)) {
		const url = pageURL(kind);
		const session = await open();
		let want;
		try {
			await session.go(url);
			want = await session.report();
		} finally {
			await session.close();
		}
		ok(
			`${engine} natively, a page with ${name} reported`,
			want && typeof want === 'object',
			JSON.stringify(want),
		);
		for (const [mode, base] of MODES) {
			const proxied = await open();
			let got;
			try {
				await proxiedGo(proxied, base, url);
				got = await proxied.report();
			} finally {
				await proxied.close();
			}
			compare(engine, mode, name, want, got);
		}
	}
}

// ---- WebKit and Firefox (test/engines.mjs) ----

await withWebKit('coi-engines', REPORT, (open) =>
	compareEngine('WebKit', open),
);
await withFirefox('coi-engines', REPORT, (open) =>
	compareEngine('Firefox', open),
);

await done(browser);
