// Cross-origin isolation through the proxy, against Chrome
// (docs/same-origin-policy.md, "Cross-origin isolation"). The demo's pages
// send COOP same-origin and an embedder policy, so the host is isolated and
// a proxied page can be: one whose own response isolates it natively reads
// `crossOriginIsolated` true, has SharedArrayBuffer, shares one with its
// workers and reads the 5 microsecond clock; every other page has what a
// page without isolation has. The fixture serves one battery
// (test/pages/coi.js) in documents with each set of headers, and every case
// is compared with the same document loaded natively, in both modes: the
// page itself, its workers, its frames of each kind and what its embedder
// policy does to its loads. The last part runs a second demo server without
// the headers (STOMP_ISOLATION=off): no proxied page is isolated there, and
// each reads what a page without the headers reads natively.
//
// COI_ONLY=<text> runs the kinds of page whose name holds the text.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture.mjs';
import {
	done,
	FIXTURE,
	HOST,
	inPool,
	launch,
	ok,
	openDemo,
	PROXY,
	RUN,
	sleep,
	waitForServer,
} from '../lib.mjs';

// Cases known to differ from Chrome, by why (docs/same-origin-policy.md). A
// case on the list that now reads as natively fails too: take it off.
const KNOWN_BY_REASON = {
	"a frame's document that sends a Document-Isolation-Policy is isolated natively wherever it loads; through the proxy only where its embedder is, because a frame of a document that is not isolated cannot be made so by any header of its own but that one, which would put it in an agent cluster apart from the documents of its origin":
		[
			'no headers: frames/same origin, a Document-Isolation-Policy',
			'an embedder policy only: frames/same origin, a Document-Isolation-Policy',
		],
	"a frame that is not isolated natively, in a page the proxy isolates with a Document-Isolation-Policy of its own under a host that is not isolated, is in that page's agent cluster (its parent reaches it there), where Chrome 157 gives every document the 5 microsecond clock and isolated dedicated workers whatever its Permissions-Policy or its element's allow say (measured): its inject hides crossOriginIsolated and SharedArrayBuffer, not the clock":
		[
			'the host is not isolated: COOP and an embedder policy: frames/same origin, an embedder policy and a permissions policy of none',
			"the host is not isolated: COOP and an embedder policy: frames/same origin, an embedder policy, allow 'none'",
			'the host is not isolated: COOP and an embedder policy: frames/another origin, an embedder and a resource policy',
			'the host is not isolated: COOP and an embedder policy: frames/another origin, allowed, through a redirect of this origin without headers',
			'the host is not isolated: COOP and an embedder policy: frames/a credentialless frame of another origin, no headers',
			'the host is not isolated: COOP and an embedder policy: frames/another origin, allowed, and its own frame of this origin',
			'the host is not isolated: COOP and a credentialless embedder policy: frames/same origin, an embedder policy and a permissions policy of none',
			"the host is not isolated: COOP and a credentialless embedder policy: frames/same origin, an embedder policy, allow 'none'",
			'the host is not isolated: COOP and a credentialless embedder policy: frames/another origin, an embedder and a resource policy',
			'the host is not isolated: COOP and a credentialless embedder policy: frames/another origin, allowed, through a redirect of this origin without headers',
			'the host is not isolated: COOP and a credentialless embedder policy: frames/a credentialless frame of another origin, no headers',
			'the host is not isolated: COOP and a credentialless embedder policy: frames/another origin, allowed, and its own frame of this origin',
		],
};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

const COOP = 'cross-origin-opener-policy:same-origin';
const COEP = 'cross-origin-embedder-policy:require-corp';
const CREDENTIALLESS = 'cross-origin-embedder-policy:credentialless';
const ALL = 'self,workers,frames,coep';
// the kinds of page: the headers of its own response, and the parts of the
// battery it runs
const KINDS = {
	'COOP and an embedder policy': { headers: [COOP, COEP], parts: ALL },
	'COOP and a credentialless embedder policy': {
		headers: [COOP, CREDENTIALLESS],
		parts: ALL,
	},
	// the redirects carry no header: on the way to the host's frame they
	// need none natively, and the proxy's own answers for them must load
	// in an isolated host of another origin
	'COOP and an embedder policy, reached through redirects': {
		headers: [COOP, COEP],
		parts: 'self',
		redirects: true,
	},
	'no headers': { headers: [], parts: ALL },
	'an embedder policy only': { headers: [COEP], parts: ALL },
	'COOP only': { headers: [COOP], parts: 'self,workers' },
	'COOP same-origin-allow-popups and an embedder policy': {
		headers: ['cross-origin-opener-policy:same-origin-allow-popups', COEP],
		parts: 'self,workers',
	},
	'the headers and a permissions policy that gives it up': {
		headers: [COOP, COEP, 'permissions-policy:cross-origin-isolated=()'],
		parts: 'self,workers',
	},
	'the headers and a permissions policy of self': {
		headers: [COOP, COEP, 'permissions-policy:cross-origin-isolated=(self)'],
		parts: 'self',
	},
	'the headers with parameters': {
		headers: [COOP, 'cross-origin-embedder-policy:require-corp; report-to="x"'],
		parts: 'self',
	},
	'the headers in report-only form': {
		headers: [
			'cross-origin-opener-policy-report-only:same-origin',
			'cross-origin-embedder-policy-report-only:require-corp',
		],
		parts: 'self',
	},
	'a Document-Isolation-Policy': {
		headers: ['document-isolation-policy:isolate-and-require-corp'],
		parts: 'self,workers',
	},
};
const only = process.env.COI_ONLY ?? '';

/** a port nothing listens on */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

// The page's site is localhost, another site 127.0.0.1, and another origin
// of the page's site the fixture once more, on another port of localhost
// (two ports of an IP address are not one site to Chrome's resource policy
// check: measured)
const B = new URL(FIXTURE).origin;
const A = B.replace('127.0.0.1', 'localhost');
const second = await startFixture(await freePort());
const C = `http://localhost:${second.address().port}`;

let run = 0;
const pageURL = ({ headers, parts, redirects }) => {
	const url = `${A}/coi/doc?parts=${parts}&b=${encodeURIComponent(B)}&c=${encodeURIComponent(C)}&k=r${RUN}x${++run}${headers
		.map((header) => `&h=${encodeURIComponent(header)}`)
		.join('')}`;
	// reached through a redirect of another site, then one of its own
	return redirects
		? `${B}/coi/to?u=${encodeURIComponent(`${A}/coi/to?u=${encodeURIComponent(url)}`)}`
		: url;
};

/** the battery's report, from whichever frame holds it */
async function report(page) {
	for (let i = 0; i < 480; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame?.evaluate(() => window.__coi).catch(() => null);
			if (value?.done) return value.cases;
		}
	}
	return null;
}

async function native(kind) {
	const page = await browser.newPage();
	await page.goto(pageURL(kind));
	const cases = await report(page);
	await page.context().close();
	return cases;
}

async function proxied(base, kind) {
	const page = await openDemo(browser, base);
	await page.evaluate((url) => {
		const form = document.getElementById('mainForm');
		form.url.value = url;
		form.requestSubmit();
	}, pageURL(kind));
	const cases = await report(page);
	await page.context().close();
	return cases;
}

// a run's ports say nothing about isolation
const normal = (value) =>
	JSON.stringify(value ?? null)
		.replaceAll(A, 'A')
		.replaceAll(B, 'B')
		.replaceAll(C, 'C');

const browser = await launch();
const natives = {};

// two kinds at once, and each kind's two modes at once: every page is in a
// browser context of its own, and every load of a page has a key of its own
// for the fixture's logs (pageURL)
await inPool(Object.entries(KINDS), 2, async ([name, kind]) => {
	if (only && !name.includes(only)) return;
	const want = (natives[name] = await native(kind));
	ok(
		`natively, a page with ${name} ran every case`,
		want !== null && Object.keys(want).length > 0,
		normal(want?.['self/crossOriginIsolated']),
	);
	await Promise.all(
		[
			['same-origin', PROXY],
			['isolated', HOST],
		].map(async ([mode, base]) => {
			const got = await proxied(base, kind);
			ok(
				`${mode}: a page with ${name} ran every case`,
				got !== null,
				normal(got?.['self/crossOriginIsolated']),
			);
			compare(`${mode}: ${name}`, want, got);
		}),
	);
});

// what the battery relies on, so a change in the browser shows here first
if (!only) {
	const isolated = natives['COOP and an embedder policy'];
	const plain = natives['no headers'];
	ok(
		'natively, the headers isolate a page and nothing else of these does',
		isolated?.['self/crossOriginIsolated'] === true &&
			natives['COOP and a credentialless embedder policy']?.[
				'self/crossOriginIsolated'
			] === true &&
			natives['a Document-Isolation-Policy']?.['self/crossOriginIsolated'] ===
				true &&
			[
				'no headers',
				'an embedder policy only',
				'COOP only',
				'COOP same-origin-allow-popups and an embedder policy',
				'the headers and a permissions policy that gives it up',
				'the headers in report-only form',
			].every((name) => natives[name]?.['self/crossOriginIsolated'] === false),
		normal(
			Object.fromEntries(
				Object.entries(natives).map(([name, cases]) => [
					name,
					cases?.['self/crossOriginIsolated'],
				]),
			),
		),
	);
	ok(
		'natively, an isolated page has SharedArrayBuffer and the 5 microsecond clock, and another has neither',
		isolated?.['self/the SharedArrayBuffer global']?.typeof === 'function' &&
			isolated?.['self/clock: performance.now'] === '5 us' &&
			plain?.['self/the SharedArrayBuffer global']?.typeof === 'undefined' &&
			plain?.['self/clock: performance.now'] === '100 us',
		normal([
			isolated?.['self/clock: performance.now'],
			plain?.['self/clock: performance.now'],
		]),
	);
}

// Frame.go before its element is in the document. A frame navigated as it
// is inserted keeps its initial document's window and that document's clock
// (the host's, 5 microseconds), so the controller navigates it once it is in
// the document; an insertion into a shadow tree is no mutation of the
// document's own, and it has to see that one too.
if (!only) {
	const page = await openDemo(browser, PROXY);
	const went = await page.evaluate(
		async (url) => {
			const host = document.createElement('div');
			const shadow = host.attachShadow({ mode: 'open' });
			document.body.append(host);
			const element = document.createElement('iframe');
			const going = window.controller
				.createFrame(element)
				.go(url)
				.then(
					() => 'resolved',
					(error) => `rejected: ${error}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 200));
			shadow.append(element);
			return Promise.race([
				going,
				new Promise((resolve) => setTimeout(() => resolve('pending'), 30000)),
			]);
		},
		pageURL({ headers: [], parts: 'self' }),
	);
	ok(
		'same-origin: Frame.go called before its element is in the document resolves once it is in a shadow tree',
		went === 'resolved',
		went,
	);
	const cases = went === 'resolved' ? await report(page) : null;
	ok(
		'same-origin: and the page, which is not isolated, has its own window: the 100 microsecond clock and no SharedArrayBuffer',
		cases?.['self/crossOriginIsolated'] === false &&
			cases?.['self/clock: performance.now'] === '100 us' &&
			cases?.['self/the SharedArrayBuffer global']?.typeof === 'undefined',
		normal([
			cases?.['self/crossOriginIsolated'],
			cases?.['self/clock: performance.now'],
			cases?.['self/the SharedArrayBuffer global'],
		]),
	);
	await page.context().close();
}

// The wait of Frame.go for its element ends: at the limit (10 s) for a
// frame that is never put in the document, which is then navigated as asked,
// and as soon as a frame dropped before it was inserted is collected. Its
// timer is the controller's own setTimeout of 100 ms, counted here.
if (!only || 'the wait of Frame.go'.includes(only)) {
	const page = await openDemo(browser, PROXY);
	const cdp = await page.context().newCDPSession(page);
	await page.evaluate(() => {
		const native = window.setTimeout;
		window.__watchTimers = 0;
		window.setTimeout = function (callback, delay, ...rest) {
			if (
				delay === 100 &&
				/\/stomp\/[^\s]*controller/i.test(new Error().stack ?? '')
			)
				window.__watchTimers++;
			return native.call(this, callback, delay, ...rest);
		};
	});
	const counted = async (ms) => {
		await page.evaluate(() => (window.__watchTimers = 0));
		await sleep(ms);
		return page.evaluate(() => window.__watchTimers);
	};
	const idle = await counted(1000);
	const url = pageURL({ headers: [], parts: 'self' });
	const kept = await page.evaluate((url) => {
		const element = document.createElement('iframe');
		window.__kept = element;
		window.controller.createFrame(element).go(url);
		return element.getAttribute('src');
	}, url);
	const watching = await counted(1000);
	await sleep(9500);
	const after = await page.evaluate(() => window.__kept.getAttribute('src'));
	const left = await counted(1000);
	ok(
		'a frame never put in the document: Frame.go watches for it, then stops at the limit and navigates it as asked',
		idle === 0 && kept === null && watching > 0 && !!after && left === 0,
		JSON.stringify({ idle, kept, watching, navigated: !!after, left }),
	);
	await page.evaluate(() => window.__kept.remove());

	await page.evaluate((url) => {
		const element = document.createElement('iframe');
		const frame = window.controller.createFrame(element);
		frame.go(url);
		// the host lets the frame go: nothing of its holds it
		window.controller.frames.splice(window.controller.frames.indexOf(frame), 1);
		window.__dropped = new WeakRef(element);
	}, url);
	const before = await counted(500);
	await cdp.send('HeapProfiler.collectGarbage');
	await sleep(300);
	await cdp.send('HeapProfiler.collectGarbage');
	const collected = await page.evaluate(
		() => window.__dropped.deref() === undefined,
	);
	const remaining = await counted(1000);
	ok(
		'a frame dropped before it is put in the document is collected, and the wait of its Frame.go ends with it',
		before > 0 && collected && remaining === 0,
		JSON.stringify({ before, collected, remaining }),
	);
	await page.context().close();
}

// The host that does not send the headers: a second demo server without
// them. A page that is isolated natively is served with a
// Document-Isolation-Policy there (Chrome 137 and later), which isolates it
// in an agent cluster of its own, and reads as natively: isolated, its
// workers and frames as natively, its embedder policy's checks the
// worker's. Every other page reads what a page without the headers reads
// natively, as before.
if (!only || 'the host is not isolated'.includes(only)) {
	const port = await freePort();
	const env = {
		...process.env,
		PORT: String(port),
		WISP_ALLOW_LOOPBACK: '1',
		STOMP_ISOLATION: 'off',
	};
	delete env.STOMP_PROXY_ORIGIN;
	delete env.STOMP_WISP_URL;
	const server = spawn(
		process.execPath,
		[fileURLToPath(new URL('../../demo/server.js', import.meta.url))],
		{ env, stdio: ['ignore', 'ignore', 'inherit'] },
	);
	// the kinds of page, the parts each runs here, and whether it is
	// isolated natively (a page that is not reads as before: its
	// document.featurePolicy is the browser's own, the proxy origin's or
	// what the host's page lets its frames have, and its embedder policy is
	// the browser's to enforce on a worker's script, which no proxied
	// document has here)
	const UNISOLATED_KINDS = [
		['COOP and an embedder policy', ALL, true],
		['COOP and a credentialless embedder policy', ALL, true],
		['a Document-Isolation-Policy', 'self,workers', true],
		['no headers', 'self,workers', false],
		[
			'the headers and a permissions policy that gives it up',
			'self,workers',
			false,
		],
	];
	const SHARED_TO_WORKER =
		'self/a SharedArrayBuffer posted to a worker is shared with it';
	const NOT_ISOLATED_SKIP = [
		'self/the permission by document.featurePolicy',
		'workers/a worker whose script has no embedder policy',
		'workers/a worker whose script has no embedder policy, through a redirect with one',
	];
	try {
		await waitForServer(`http://127.0.0.1:${port}/api/status`);
		const wants = {};
		for (const [name, parts] of UNISOLATED_KINDS) {
			const kind = { ...KINDS[name], parts };
			wants[name] =
				natives[name] && KINDS[name].parts === parts
					? natives[name]
					: await native(kind);
		}
		for (const [mode, base] of [
			['same-origin', `http://127.0.0.1:${port}/`],
			['isolated', `http://localhost:${port}/`],
		]) {
			const hostIsolated = await (async () => {
				const page = await openDemo(browser, base);
				const value = await page.evaluate(() => self.crossOriginIsolated);
				await page.context().close();
				return value;
			})();
			ok(
				`${mode}: the host that does not send the headers is not isolated`,
				hostIsolated === false,
				String(hostIsolated),
			);
			for (const [name, parts, isolated] of UNISOLATED_KINDS) {
				const got = await proxied(base, { ...KINDS[name], parts });
				ok(
					`${mode}, the host is not isolated: a page with ${name} ran every case`,
					got !== null,
					normal(got?.['self/crossOriginIsolated']),
				);
				// (Chrome 137 and later: the proxy's own Document-Isolation-Policy)
				ok(
					`${mode}, the host is not isolated: a page with ${name} is ${isolated ? 'isolated, and a SharedArrayBuffer it posts to a worker is shared' : 'not isolated'}`,
					isolated
						? got?.['self/crossOriginIsolated'] === true &&
								normal(got[SHARED_TO_WORKER]) ===
									normal(['[object SharedArrayBuffer]', 7])
						: got?.['self/crossOriginIsolated'] === false,
					normal([got?.['self/crossOriginIsolated'], got?.[SHARED_TO_WORKER]]),
				);
				compare(
					`${mode}, the host is not isolated: ${name}`,
					wants[name],
					got,
					isolated ? [] : NOT_ISOLATED_SKIP,
				);
			}
		}
	} finally {
		server.kill();
	}
}

second.close();
await done(browser);

/** each case natively against the proxy, a known difference against its list */
function compare(label, want, got, skip = []) {
	for (const name of Object.keys(want ?? {})) {
		if (skip.includes(name)) continue;
		const wanted = normal(want[name]);
		const had = normal(got?.[name]);
		const detail = `\n      native  ${wanted}\n      proxied ${had}`;
		// (a mode's label leads: "isolated: " or "same-origin, ")
		const known = KNOWN.get(
			`${label.replace(/^(same-origin|isolated)(: |, )/, '')}: ${name}`,
		);
		if (known)
			ok(
				`${label}: ${name} differs as known (${known})`,
				wanted !== had,
				`now as natively: take it off the list${detail}`,
			);
		else ok(`${label}: ${name} as natively`, wanted === had, detail);
	}
}
