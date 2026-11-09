// A frame the page sandboxes is restricted through the proxy as it is
// natively. The proxy cannot leave the page's sandbox on the real frame as
// written: without allow-same-origin the document is an opaque origin the
// service worker never sees, and without allow-scripts the inject itself
// could not run. So every restriction is compared with the same pages loaded
// natively, in both demo modes:
//
// - test/pages/sandbox-restrictions.html: frames without allow-scripts load
//   sandbox-restrictions-noscript.html (every way a document runs script:
//   inline, module and external scripts, event handlers, javascript: URLs in
//   a link and a frame, srcdoc, nested frames and an object, each requesting
//   a beacon of its run and case from the fixture), a sandboxed srcdoc, markup
//   the page writes into a sandboxed about:blank, a javascript: URL the page
//   navigates a sandboxed frame to, and frames sandboxed (or unsandboxed)
//   after they loaded, then navigated. No beacon of a script may ever arrive
//   from a frame without allow-scripts; the noscript content must render. The
//   probe frames (sandbox-restrictions-probe.html) report their origin,
//   storage, cookies, IndexedDB, Cache Storage, parent and top access, the
//   Origin of their requests, form submission, window.open, the modal
//   dialogs and print, a download, pointer lock, presentation and orientation
//   lock, nested frames included; the page reads each frame's
//   contentDocument and contentWindow.document and its sandbox attribute.
// - sandbox-restrictions-popups.html: popups of sandboxed frames inherit the
//   sandbox unless allow-popups-to-escape-sandbox; without allow-popups none
//   opens.
// - sandbox-restrictions-top.html: a sandboxed frame navigating the top, by
//   script, by a click and by a target=_top link, under each top navigation
//   flag.
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
// where a run is, on stderr (a hung step shows which)
const step = (text) => console.error(`# ${new Date().toISOString()} ${text}`);
const ROUTED = /\/stomp\/[\w-]+\/html[/:]/;

// the frames of the main harness that must run no script at all
const NO_SCRIPT = [
	'ns-empty',
	'ns-same',
	'ns-most',
	'ns-upper',
	'ns-late-next',
	'ns-lifted',
	'sd-empty',
	'wr-same',
	'js-same',
];
// what each restriction probe reports, by key
const PROBE_KEYS = [
	'origin',
	'localStorage',
	'sessionStorage',
	'cookieRead',
	'cookieWrite',
	'indexedDB',
	'caches',
	'frameElement',
	'parentDocument',
	'topDocument',
	'fetch',
	'fetchOmit',
	'form',
	'open',
	'alert',
	'confirm',
	'prompt',
	'print',
	'prints',
	'pointerLock',
	'presentation',
	'orientation',
];
// the reports by request to the fixture: popups and the top navigation
// cases whose frame reports what it caught
const BEACON_REPORTS = [
	'pop-scripts-popup',
	'pop-scripts-escape-popup',
	'tn-none',
	'tn-allow',
	'tn-ua',
	'tn-ua-click',
	'tn-click-none',
	'tn-custom-none',
	'tn-custom',
];
const PROBES = [
	'p-scripts',
	'p-same',
	'p-all',
	'p-plain',
	'p-nested',
	'p-nested-child',
	'p-nested-same',
	'p-nested-same-child',
];

/** what the fixture saw of `run`: beacons by case, reports by key */
async function seen(run) {
	const served = await (await fetch(`${FIXTURE}requests`)).json();
	const beacons = {};
	const reports = {};
	for (const path of served) {
		const beacon = new RegExp(`^/pages/deep/${run}/([^/]+)/beacon/(.+)$`).exec(
			path,
		);
		if (beacon) (beacons[beacon[1]] ??= new Set()).add(beacon[2]);
		const report = new RegExp(`^/sr-report/${run}/([^/]+)/(.+)$`).exec(path);
		if (report)
			try {
				reports[report[1]] = JSON.parse(decodeURIComponent(report[2]));
			} catch (error) {
				reports[report[1]] = `unreadable ${report[2]}`;
			}
	}
	return { beacons, reports };
}
const scripts = (set) => [...(set ?? [])].filter((b) => b.startsWith('s-'));
// An <object>'s HTML document loads into a blob: copy no service worker
// controls, whose relative loads miss the worker, so its beacons never
// arrive through the proxy, sandboxed or not (a known limit of object
// documents, not of the sandbox): left out of the comparisons with native,
// still counted by the checks that no script ran
const OBJECT_BEACONS = ['n-object', 's-object'];
const list = (set) =>
	[...(set ?? [])]
		.filter((beacon) => !OBJECT_BEACONS.includes(beacon))
		.sort()
		.join(' ');
/** whether case `name` loaded what it shows (a javascript: URL frame shows nothing) */
const rendered = (beacons, name) =>
	name.startsWith('js-') ||
	[...(beacons[name] ?? [])].some((b) => b.startsWith('n-'));

/**
 * What the fixture saw of `run` once it stops changing: `keys` (report
 * keys) all present, or the beacons the same two seconds apart, within
 * `cap` ms. A busy machine delivers a frame's loads and reports late, and a
 * fixed wait read them before they came.
 */
async function settled(run, keys = [], cap = 60000) {
	const start = Date.now();
	let last = '';
	for (;;) {
		const now = await seen(run);
		const shape = JSON.stringify(
			Object.entries(now.beacons).map(([name, set]) => [name, list(set)]),
		);
		const complete = keys.every((key) => key in now.reports);
		if ((complete && shape === last) || Date.now() - start > cap) return now;
		last = shape;
		await sleep(2000);
	}
}

/** click `selector` in every frame of `page` that has it */
async function clickIn(page, selector) {
	for (const frame of page.frames()) {
		// a frame of a page whose other frames show modal dialogs can take a
		// while to answer; a frame in a dialog itself never does
		const handle = await Promise.race([
			frame.$(selector).catch(() => null),
			sleep(10000).then(() => null),
		]);
		if (handle)
			await handle.click({ timeout: 10000 }).catch(() => {
				// a frame that navigated meanwhile
			});
	}
}

/** `run` evaluated in `frame`, or `fallback` after `ms` (a frame in a modal never answers) */
const within = (frame, run, arg, fallback, ms = 3000) =>
	Promise.race([
		frame.evaluate(run, arg).catch(() => fallback),
		sleep(ms).then(() => fallback),
	]);

/**
 * The harness frame of `page` once its `global` says done, polled: the page
 * itself natively, the proxied top through the proxy (only those: a probe
 * frame may sit in a modal dialog, and an evaluation there never returns)
 */
async function frameWith(page, global, tries = 600) {
	for (let i = 0; i < tries; i++) {
		for (const frame of page.frames()) {
			if (
				frame !== page.mainFrame() &&
				!(ROUTED.test(frame.url()) && frame.parentFrame() === page.mainFrame())
			)
				continue;
			const found = await within(
				frame,
				(name) => !!window[name]?.done,
				global,
				false,
			);
			if (found) return frame;
		}
		await sleep(250);
	}
	return null;
}

/** watch dialogs and downloads of every page of `context` */
function watch(context) {
	const events = { dialogs: [], downloads: [] };
	const attach = (page) => {
		page.on('dialog', (dialog) => {
			events.dialogs.push(dialog.message());
			dialog.dismiss().catch(() => {});
		});
		page.on('download', (download) =>
			events.downloads.push(download.suggestedFilename()),
		);
	};
	context.on('page', attach);
	for (const page of context.pages()) attach(page);
	return events;
}

const browser = await launch();

// the main harness, the popup harness and each top navigation case, loaded
// by `load(url)` in `context`; `topTitle()` is the title of the page's top
// (natively the page, through the proxy the proxied top document)
async function measure(label, context, load, topTitle, reportKeys) {
	const run = `${RUN}${label}`;
	const events = watch(context);
	const result = { run };

	step(`${label}: main harness`);
	const page = await load(
		`${FIXTURE}pages/sandbox-restrictions.html?run=${run}`,
	);
	const harness = await frameWith(page, '__sr');
	result.sr = harness
		? await within(harness, () => window.__sr, undefined, null, 10000)
		: null;
	await clickIn(page, '#jslink');
	await sleep(1500);

	// the popups that stay sandboxed (or never open) first, together; each
	// that escapes alone, since the demo opens it as a tab over the page
	for (const cases of [
		'pop-noscript,pop-noscript-blocked,pop-scripts',
		'pop-noscript-escape',
		'pop-scripts-escape',
	]) {
		step(`${label}: popups ${cases}`);
		const popups = await load(
			`${FIXTURE}pages/sandbox-restrictions-popups.html?run=${run}&cases=${cases}`,
		);
		await sleep(3000);
		await clickIn(popups, '#popup');
		await clickIn(popups, '#open');
		await sleep(4000);
	}

	result.top = {};
	for (const [name, sandbox, mode] of [
		['tn-none', 'allow-scripts', 'auto'],
		['tn-allow', 'allow-scripts allow-top-navigation', 'auto'],
		['tn-ua', 'allow-scripts allow-top-navigation-by-user-activation', 'auto'],
		[
			'tn-ua-click',
			'allow-scripts allow-top-navigation-by-user-activation',
			'click',
		],
		['tn-click-none', 'allow-scripts', 'click'],
		['tn-custom-none', 'allow-scripts', 'custom'],
		[
			'tn-custom',
			'allow-scripts allow-top-navigation-to-custom-protocols',
			'custom',
		],
		['tn-link-none', 'allow-same-origin', 'link'],
		['tn-link-allow', 'allow-same-origin allow-top-navigation', 'link'],
		[
			'tn-link-ua',
			'allow-same-origin allow-top-navigation-by-user-activation',
			'link',
		],
	]) {
		step(`${label}: ${name}`);
		const topPage = await load(
			`${FIXTURE}pages/sandbox-restrictions-top.html?run=${run}&case=${name}&mode=${mode}&sandbox=${encodeURIComponent(sandbox)}`,
		);
		await sleep(2500);
		if (mode === 'click') await clickIn(topPage, '#topnav');
		if (mode === 'link') await clickIn(topPage, '#toplink');
		// the top lands within six seconds of the attempt or not at all
		let title = null;
		for (let i = 0; i < 12 && title !== 'SR LANDED'; i++) {
			await sleep(500);
			title = await topTitle(topPage);
		}
		result.top[name] = title;
	}

	result.events = events;
	Object.assign(result, await settled(run, reportKeys));
	return result;
}

// natively: each harness its own page of one context
const nativeContext = await browser.newContext();
const native = await measure(
	'n',
	nativeContext,
	async (url) => {
		const page = await nativeContext.newPage();
		await page.goto(url);
		return page;
	},
	(page) => page.title().catch(() => null),
	BEACON_REPORTS,
);
await nativeContext.close();

// every case the comparisons read must have reported natively: a missing
// one is the measurement's failure, never compared as undefined
const LATE = ['p-late', 'p-late-again', 'p-late-next'];
const nativeMissing = [
	...[...PROBES, ...LATE].filter((name) => !native.sr?.reports?.[name]),
	...BEACON_REPORTS.filter((name) => !native.reports[name]),
];
for (const name of nativeMissing)
	ok(`native report missing for ${name}`, false);
ok(
	'natively every case reported',
	nativeMissing.length === 0,
	nativeMissing.join(' '),
);
/** compare `name` only when both sides reported it; say which did not */
const reported = (mode, name, native, proxied) => {
	if (!native) return false;
	if (!proxied) {
		ok(`${mode}: proxied report missing for ${name}`, false);
		return false;
	}
	return true;
};

ok(
	'natively the main harness ran',
	native.sr?.done === true,
	JSON.stringify(native.sr)?.slice(0, 300),
);
ok(
	'natively no frame without allow-scripts runs a script, and each rendered',
	NO_SCRIPT.every(
		(name) =>
			scripts(native.beacons[name]).length === 0 &&
			rendered(native.beacons, name),
	),
	NO_SCRIPT.map((name) => `${name}: ${list(native.beacons[name])}`).join('; '),
);
ok(
	'natively every script vector of a frame with allow-scripts runs',
	scripts(native.beacons['ns-control']).length >= 12,
	list(native.beacons['ns-control']),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const context = await browser.newContext();
	const host = await openDemo(context, base).catch(() => null);
	if (!host) {
		ok(`${mode}: the demo opened`, false);
		continue;
	}
	// every host page the run opened: none may be navigated off the demo
	const hosts = [host];
	const proxied = await measure(
		mode === 'same-origin' ? 's' : 'i',
		context,
		async (url) => {
			const page = await openDemo(context, base);
			hosts.push(page);
			await submitLanding(page, url);
			return page;
		},
		async (page) => {
			// the proxied top: a routed frame right under the host page
			for (const frame of page.frames())
				if (
					ROUTED.test(frame.url()) &&
					frame.parentFrame() === page.mainFrame()
				) {
					const title = await within(
						frame,
						() => document.title,
						undefined,
						null,
					);
					if (title) return title;
				}
			return null;
		},
		BEACON_REPORTS,
	);
	const same = (name, a, b) => {
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		ok(`${mode}: ${name} as natively`, x === y, `native ${x} proxied ${y}`);
	};

	ok(`${mode}: the main harness ran`, proxied.sr?.done === true);

	// no script ever runs where natively none does
	for (const name of NO_SCRIPT)
		ok(
			`${mode}: no script runs in ${name} (sandbox without allow-scripts)`,
			scripts(proxied.beacons[name]).length === 0 &&
				rendered(proxied.beacons, name),
			list(proxied.beacons[name]) || 'nothing loaded',
		);
	for (const name of [
		...NO_SCRIPT,
		'ns-control',
		'ns-plain',
		'ns-late',
		'sd-control',
		'wr-control',
		'js-control',
		'ns-lifted-next',
	])
		same(
			`what ${name} loads and runs is`,
			list(native.beacons[name]),
			list(proxied.beacons[name]),
		);

	for (const name of PROBES) {
		if (
			!reported(
				mode,
				name,
				native.sr?.reports?.[name],
				proxied.sr?.reports?.[name],
			)
		)
			continue;
		for (const key of PROBE_KEYS) {
			// a lock the sandbox allows can meet Chrome's limit on pointer lock
			// requests in a short window (frames of one page share it): only
			// the refusals the sandbox makes are compared
			if (
				key === 'pointerLock' &&
				native.sr?.reports?.[name]?.[key] === 'locked'
			)
				continue;
			same(
				`${name} ${key}`,
				native.sr.reports[name][key],
				proxied.sr.reports[name][key],
			);
		}
	}
	for (const name of LATE)
		if (
			reported(
				mode,
				name,
				native.sr?.reports?.[name],
				proxied.sr?.reports?.[name],
			)
		)
			same(
				`${name} (the sandbox applies from the next navigation) origin and storage`,
				[
					native.sr?.reports?.[name]?.origin,
					native.sr?.reports?.[name]?.localStorage,
				],
				[
					proxied.sr?.reports?.[name]?.origin,
					proxied.sr?.reports?.[name]?.localStorage,
				],
			);
	for (const name of Object.keys(native.sr?.parentReads ?? {}))
		same(
			`what the page reads of ${name} (contentDocument, contentWindow.document, the attribute, its token list)`,
			native.sr.parentReads[name],
			proxied.sr?.parentReads?.[name],
		);

	same(
		'the dialogs shown are',
		[...native.events.dialogs].sort(),
		[...proxied.events.dialogs].sort(),
	);
	same(
		'the downloads made are',
		[...native.events.downloads].sort(),
		[...proxied.events.downloads].sort(),
	);

	// popups
	for (const name of [
		'pop-noscript',
		'pop-noscript-escape',
		'pop-noscript-blocked',
	])
		same(
			`what the popup of ${name} loads and runs is`,
			list(native.beacons[name]),
			list(proxied.beacons[name]),
		);
	ok(
		`${mode}: no script runs in the popup of a frame without allow-scripts`,
		scripts(proxied.beacons['pop-noscript']).length === 0,
		list(proxied.beacons['pop-noscript']),
	);
	for (const name of ['pop-scripts-popup', 'pop-scripts-escape-popup'])
		if (reported(mode, name, native.reports[name], proxied.reports[name]))
			same(
				`the origin of the popup ${name} is`,
				native.reports[name]?.origin,
				proxied.reports[name]?.origin,
			);

	// top navigation
	for (const name of Object.keys(native.top))
		same(
			`${name}: the top's title after the frame tried to navigate it is`,
			native.top[name],
			proxied.top[name],
		);
	for (const name of [
		'tn-none',
		'tn-allow',
		'tn-ua',
		'tn-ua-click',
		'tn-click-none',
		'tn-custom-none',
		'tn-custom',
	])
		if (reported(mode, name, native.reports[name], proxied.reports[name]))
			same(
				`${name}: what the frame caught navigating the top is`,
				native.reports[name]?.caught,
				proxied.reports[name]?.caught,
			);
	ok(
		`${mode}: no host page ever left the demo`,
		// the demo's own page (a hash names its tabs); a top escape in
		// same-origin mode puts a route there
		hosts.every(
			(page) =>
				page.isClosed() ||
				(page.url().startsWith(base) && new URL(page.url()).pathname === '/'),
		),
		hosts.map((page) => (page.isClosed() ? 'closed' : page.url())).join(' '),
	);
	await context.close();
}

// no run may ever have seen a script beacon from a frame without allow-scripts
const all = await seen(`${RUN}[nsi]`);
ok(
	'no beacon of a script in a frame without allow-scripts ever reached the fixture',
	NO_SCRIPT.concat(['pop-noscript']).every(
		(name) => scripts(all.beacons[name]).length === 0,
	),
	NO_SCRIPT.concat(['pop-noscript'])
		.map((name) => `${name}: ${scripts(all.beacons[name]).join(' ')}`)
		.join('; '),
);
await done(browser);
