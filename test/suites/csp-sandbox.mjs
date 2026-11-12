// A page's Content-Security-Policy `sandbox` directive sandboxes it through
// the proxy as natively (test/csp-server.mjs /csp/sbx,
// test/pages/csp-sandbox-probes.js): each case is a document under a header
// policy with the directive (several, upper case, an unknown flag, beside
// fetch directives, as Cloudflare's challenge frame sends it), or under a
// meta or a report-only one (both ignored natively). Its probes read its
// origin, document.domain and its setter, cookies, storage, IndexedDB,
// Cache Storage and a fetch's response type; its markup's scripts run or
// not; modal dialogs, forms and popups (a popup inherits the sandbox) go
// or are refused; a frame under it navigates its top or is refused; its
// frames (http, srcdoc, about:blank) inherit the flags; and a frame's
// sandbox attribute narrows its document's directive. Every outcome is sent
// to the fixture, compared with the page loaded natively, in both modes.
// The proxy used to drop the directive: Cloudflare's challenge frame
// (`sandbox allow-same-origin allow-scripts allow-popups allow-forms`)
// expects `document.domain = x` to throw, and it did not.
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

const RUN = Date.now().toString(36);
const step = (text) => console.error(`# ${new Date().toISOString()} ${text}`);

/** a /csp/sbx page */
function doc(
	key,
	{ p = [], ro = [], m = [], role, probes = [], b, frame, fs },
) {
	const query = new URLSearchParams();
	for (const policy of [].concat(p)) query.append('p', policy);
	for (const policy of [].concat(ro)) query.append('ro', policy);
	for (const policy of [].concat(m)) query.append('m', policy);
	query.set('k', key);
	if (role) query.set('role', role);
	query.set('probes', probes.join(','));
	if (b) query.set('b', b);
	if (frame) query.set('frame', frame);
	if (fs !== undefined) query.set('fs', fs);
	return `${FIXTURE.replace(/\/$/, '')}/csp/sbx?${query}`;
}
/** a page that frames `child` (relative, so the frame is of its origin) */
const framing = (child, fs) => (key) =>
	doc(key, {
		frame: new URL(child(key)).pathname + new URL(child(key)).search,
		fs,
	});

const TURNSTILE =
	"default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; sandbox allow-same-origin allow-scripts allow-popups allow-forms";

// name: [the page (by key), what must have arrived, a click in a role's document]
const CASES = {
	'allow-scripts': [
		(k) => doc(k, { p: 'sandbox allow-scripts', probes: ['env'] }),
		['top done'],
	],
	'allow-scripts allow-same-origin': [
		(k) =>
			doc(k, { p: 'sandbox allow-scripts allow-same-origin', probes: ['env'] }),
		['top done'],
	],
	turnstile: [(k) => doc(k, { p: TURNSTILE, probes: ['env'] }), ['top done']],
	'unknown flag': [
		(k) => doc(k, { p: 'sandbox allow-scripts allow-bogus', probes: ['env'] }),
		['top done'],
	],
	'upper case': [
		(k) => doc(k, { p: 'SANDBOX ALLOW-SCRIPTS', probes: ['env'] }),
		['top done'],
	],
	'beside connect-src': [
		(k) =>
			doc(k, {
				p: "sandbox allow-scripts; connect-src 'none'",
				probes: ['env'],
			}),
		['top done'],
	],
	'two policies intersect': [
		(k) =>
			doc(k, {
				p: [
					'sandbox allow-scripts allow-same-origin',
					'sandbox allow-scripts allow-modals',
				],
				probes: ['env', 'modals'],
			}),
		['top done'],
	],
	'meta is ignored': [
		(k) => doc(k, { m: 'sandbox', probes: ['env'] }),
		['top done'],
	],
	'report-only is ignored': [
		(k) => doc(k, { ro: 'sandbox', probes: ['env'] }),
		['top done'],
	],
	'no flags': [
		(k) => doc(k, { p: 'sandbox', b: 'noscript', probes: ['env'] }),
		['top end'],
	],
	'no scripts, same origin': [
		(k) =>
			doc(k, {
				p: 'sandbox allow-same-origin allow-forms allow-popups',
				b: 'noscript',
				probes: ['env'],
			}),
		['top end'],
	],
	'scripts, markup': [
		(k) =>
			doc(k, { p: 'sandbox allow-scripts', b: 'noscript', probes: ['env'] }),
		['top done', 'top end'],
	],
	'modals refused': [
		(k) => doc(k, { p: 'sandbox allow-scripts', probes: ['modals', 'print'] }),
		['top done'],
	],
	'modals allowed': [
		(k) =>
			doc(k, { p: 'sandbox allow-scripts allow-modals', probes: ['modals'] }),
		['top done'],
	],
	'forms refused': [
		(k) => doc(k, { p: 'sandbox allow-scripts', probes: ['form'] }),
		['top done'],
	],
	'forms allowed': [
		(k) => doc(k, { p: 'sandbox allow-scripts allow-forms', probes: ['form'] }),
		['top form'],
	],
	'popups refused': [
		(k) => doc(k, { p: 'sandbox allow-scripts', probes: ['popup'] }),
		['top done'],
		'top',
	],
	popups: [
		(k) =>
			doc(k, { p: 'sandbox allow-scripts allow-popups', probes: ['popup'] }),
		['top done', 'popup done'],
		'top',
	],
	'popups, same origin': [
		(k) =>
			doc(k, {
				p: 'sandbox allow-scripts allow-popups allow-same-origin',
				probes: ['popup'],
			}),
		['top done', 'popup done'],
		'top',
	],
	'top navigation refused': [
		framing((k) =>
			doc(k, {
				p: 'sandbox allow-scripts',
				role: 'child',
				probes: ['top-href', 'top-replace', 'top-open'],
			}),
		),
		['child done', 'top end'],
	],
	'top navigation, opaque': [
		framing((k) =>
			doc(k, {
				p: 'sandbox allow-scripts allow-top-navigation',
				role: 'child',
				probes: ['top-href'],
			}),
		),
		['child done', 'top end'],
	],
	'top navigation, same origin': [
		framing((k) =>
			doc(k, {
				p: 'sandbox allow-scripts allow-same-origin allow-top-navigation',
				role: 'child',
				probes: ['top-href'],
			}),
		),
		['top-href'],
	],
	'top navigation by activation, none': [
		framing((k) =>
			doc(k, {
				p: 'sandbox allow-scripts allow-top-navigation-by-user-activation',
				role: 'child',
				probes: ['top-href'],
			}),
		),
		['child done', 'top end'],
	],
	'frames, opaque': [
		(k) => doc(k, { p: 'sandbox allow-scripts', probes: ['frames'] }),
		['top done', 'child done'],
	],
	'frames, same origin': [
		(k) =>
			doc(k, {
				p: 'sandbox allow-scripts allow-same-origin',
				probes: ['frames'],
			}),
		['top done', 'child done'],
	],
	'frames, no scripts': [
		(k) =>
			doc(k, {
				p: 'sandbox',
				b: 'noscript',
				frame: new URL(
					doc(k, { role: 'child', b: 'noscript', probes: ['env'] }),
				).search.replace(/^/, '/csp/sbx'),
			}),
		['top end', 'child end'],
	],
	'frame attribute and policy': [
		framing(
			(k) =>
				doc(k, {
					p: 'sandbox allow-scripts allow-same-origin allow-forms',
					role: 'child',
					probes: ['env', 'modals', 'form'],
				}),
			'allow-scripts allow-same-origin allow-modals',
		),
		['child done'],
	],
};

const kept = (key) =>
	fetch(
		`${FIXTURE.replace(/\/$/, '')}/csp/sbx-get?k=${encodeURIComponent(key)}`,
	).then((response) => response.json());

/** the document of `page` with `key` and `role` */
async function documentOf(page, key, role) {
	for (let i = 0; i < 120; i++) {
		for (const frame of page.frames().reverse()) {
			const found = await frame
				.evaluate(
					([k, r]) =>
						document.body?.dataset.k === k && document.body.dataset.role === r,
					[key, role],
				)
				.catch(() => false);
			if (found) return frame;
		}
		await sleep(250);
	}
	return null;
}

/**
 * What a case did: everything its documents sent, once `wanted` arrived
 * (and a little longer), with the dialogs its page showed, its key read as
 * `<k>`
 */
async function outcome(key, wanted, dialogs) {
	let values = {};
	for (let i = 0; i < 80; i++) {
		values = await kept(key);
		if (wanted.every((name) => name in values)) break;
		await sleep(250);
	}
	await sleep(1500);
	values = await kept(key);
	values.dialogs = String(dialogs());
	return JSON.parse(JSON.stringify(values).split(key).join('<k>'));
}

/** run every case in `open` (which loads a URL and returns the page it is in) */
async function measure(label, open) {
	const results = {};
	for (const [name, [url, wanted, click]] of Object.entries(CASES)) {
		step(`${label}: ${name}`);
		const key = `${RUN}-${label}-${name.replace(/\W+/g, '-')}`;
		const { page, dialogs } = await open(url(key));
		if (click) {
			const frame = await documentOf(page, key, click);
			if (frame) await frame.click('#b', { timeout: 5000 }).catch(() => {});
		}
		results[name] = await outcome(key, wanted, dialogs);
	}
	return results;
}

const browser = await launch();

// natively: each case its own page of one context
const context = await browser.newContext();
const native = await measure('native', async (url) => {
	const page = await context.newPage();
	let count = 0;
	page.on('dialog', (dialog) => {
		count++;
		dialog.dismiss().catch(() => {});
	});
	await page.goto(url);
	return { page, dialogs: () => count };
});
await context.close();
const missing = Object.entries(CASES)
	.filter(([name, [, wanted]]) => !wanted.every((item) => item in native[name]))
	.map(([name]) => name);
ok('natively, every case reports', missing.length === 0, missing.join(', '));
ok(
	"natively, Cloudflare's challenge frame's document.domain setter throws",
	native.turnstile['top: document.domain='] ===
		"threw SecurityError: Failed to set the 'domain' property on 'Document': Assignment is forbidden for sandboxed iframes.",
	native.turnstile['top: document.domain='],
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const demo = await openDemo(browser, base);
	let count = 0;
	demo.on('dialog', (dialog) => {
		count++;
		dialog.dismiss().catch(() => {});
	});
	const proxied = await measure(mode, async (url) => {
		const start = count;
		await submitLanding(demo, url);
		return { page: demo, dialogs: () => count - start };
	});
	for (const name of Object.keys(CASES)) {
		const want = native[name];
		const got = proxied[name];
		const keys = [
			...new Set([...Object.keys(want), ...Object.keys(got)]),
		].sort();
		const differing = keys.filter((item) => want[item] !== got[item]);
		ok(
			`${mode}: ${name}: as natively`,
			differing.length === 0,
			JSON.stringify(
				Object.fromEntries(
					differing.map((item) => [item, [want[item], got[item]]]),
				),
			).slice(0, 3000),
		);
	}
	// the popups the cases opened
	for (const page of demo.context().pages())
		if (page !== demo) await page.close();
	await demo.close();
}
await done(browser);
