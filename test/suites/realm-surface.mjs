// The platform as a page's own code reads it, realm by realm, natively and
// through the proxy (test/pages/realm-surface.html and realm-walker.js,
// which is loaded as an ordinary script so the proxy rewrites it like any
// page code). The walker goes from each realm's global through every
// constructor, prototype, namespace and singleton it can reach and records
// key order, descriptors, function shapes and sources, prototype chains,
// what each getter answers on the object that holds it and on the instances
// that inherit it, and how deliberate misuse fails (error type, message,
// whose realm, stack shape). Each fact of each realm must read through the
// proxy as it does natively, in both demo modes; a fact that differs between
// two native loads (a clock, a random id) is left out, and so is what
// EXCLUDED lists, each with its reason.
//
// The realms: the top document, frames (same origin, another origin,
// srcdoc, about:blank read the moment it exists and after it loaded,
// written with document.write, removed from the document, sandboxed with
// and without its origin, a data: URL, a javascript: URL), <object> and
// <embed> documents, documents without a window (createHTMLDocument,
// DOMParser, a template's), popups (about:blank and a URL), workers
// (classic and module, by URL and by blob:, a worker's worker, shared,
// service), the audio and paint worklets' scopes, and the layout and
// animation worklets', which a Chrome has only with a blink feature on
// (CSSLayoutAPI, AnimationWorklet): the `worklets` set is walked in a
// browser of its own with both on, natively and through the proxy alike.
//
// REALM_SURFACE_DUMP=<directory> writes every record and the differences.
// REALM_SURFACE_SETS=frames,popups,workers,worklets picks the sets.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	proxiedOnlyErrors,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const DUMP = process.env.REALM_SURFACE_DUMP;
const SETS = (
	process.env.REALM_SURFACE_SETS || 'frames,popups,workers,worklets'
).split(',');
const AVOID = (process.env.REALM_SURFACE_AVOID || '')
	.split(' ')
	.filter(Boolean);
const ONLY = process.env.REALM_SURFACE_ONLY;

// Facts that are not compared, each with the reason it differs for a page
// that is where a proxied page is: [realm pattern, fact pattern, reason].
// One marked OPEN is a difference the proxy makes and has yet to unmake.
const EXCLUDED = [
	[
		/^(top|popup-)/,
		/^G\.(inner|outer)(Width|Height)$|^G\.screen(X|Y|Left|Top)$|^G\.visualViewport~(width|height)$|^G\.viewport\.segments\.0~/,
		"the page's viewport is the host's frame for it, smaller than the window and not at its corner",
	],
	[
		/./,
		/^G\.history~length$/,
		"the length of the tab's joint history: the native page is its tab's second entry, the proxied one shares the host tab's",
	],
	[
		/^top$/,
		/^G\.navigation\.activation~navigationType$/,
		'the demo host shows a page by replacing the document of the frame it made for it, where a tab pushes one',
	],
	[
		/./,
		/~lastModified$/,
		'the second the document was made, where no Last-Modified header names one: the loads are seconds apart',
	],
	[
		/./,
		/^G\.document\.timeline~currentTime$|\.connection~(downlink|rtt)$/,
		"a clock, and the browser's estimate of the network, which move between loads",
	],
	[
		/./,
		/^G\.performance(\.timing~|~timeOrigin$)/,
		"a clock: the moments the document's load passed and the realm's time origin, which two native loads share only by chance (one at 0 is no moment, and is compared)",
		null,
		(native, proxied) =>
			/^number:[1-9]/.test(String(native)) &&
			/^number:[1-9]/.test(String(proxied)),
	],
	[
		/./,
		/\.userActivation~(hasBeenActive|isActive)$/,
		"OPEN: the host page's activation is its frames': the suite starts the page from a script in the host (as a user's click in the host does), and the proxied page reads as activated before anyone touched it",
	],
	[
		/./,
		/^G\.RegExp\.(\$[&_`'+1-9]|input|lastMatch|lastParen|leftContext|rightContext)$/,
		"OPEN: RegExp's legacy static properties hold the last match of any regular expression the realm ran, the inject's own included (the walker's own natively)",
	],
	[
		/./,
		/^G\.document~(webkitF|f)ullscreenEnabled$/,
		"OPEN: the isolated demo host's frame delegates no fullscreen (its allow attribute), and the page reads that it has none",
		'isolated',
	],
	[
		/^frame-srcdoc$/,
		/^G\.document~referrer$/,
		"OPEN: a srcdoc document's referrer is its parent's origin natively, and empty through the proxy",
	],
	[
		/^(object|embed)-document$/,
		/^G\.navigation\.currentEntry~url$/,
		"OPEN: an <object>'s or <embed>'s document is a blob: copy the inject loads, and its navigation entry names the copy",
	],
	[
		/^(blank-|popup-blank-|frame-written$)/,
		/./,
		"OPEN: in a frame its parent's bundle hooks (one read before it loaded) a hook that refuses with the bundle realm's native throws the parent realm's error, and a descriptor of the frame's unforgeable members read through the parent's reflection has the parent realm's functions",
		null,
		(native, proxied) =>
			typeof native === 'string' &&
			typeof proxied === 'string' &&
			proxied
				.replaceAll('|proto=reader', '')
				.replace(/\/(reader|other)\//g, '/own/')
				.replace(
					'!TypeError/TypeError/own/stack,message/-: Illegal invocation',
					'!illegal',
				)
				.replaceAll(
					'!TypeError/TypeError/own/stack,message/-: Illegal invocation',
					'!illegal',
				) === native,
	],
	[
		/^(blank-|popup-blank-)/,
		/^G:keys$/,
		"OPEN: the WebGL interfaces a frame's inject defines late are listed where they were defined, when the frame's window is listed through another realm's reflection",
	],
	[
		/^frame-written$/,
		/^G\.document~(body|activeElement)$/,
		'OPEN: in a document written with document.write a script right after <body> runs in the head, before there is a body',
	],
	[
		/./,
		/^G\.(Element|ShadowRoot|CharacterData)\.prototype(:keys$|\.stream[A-Za-z]*HTML[A-Za-z]*($|[.:~]))/,
		"the stream forms of the markup insertion members Chrome 157 added (streamHTML(Unsafe), streamAppendHTML and their kin) are taken off the page's prototypes, as every markup member the inject does not hook (src/inject/dom/modules/DOMHooks.ts MARKUP_INSERTION says why): a page reads them as a Chrome before 157 has them, absent",
		null,
		(native, proxied) => {
			if (proxied === undefined) return true;
			const strip = (value) =>
				String(value)
					.replace(/(^|[,:])stream[A-Za-z]*HTML[A-Za-z]*(?=,|$)/g, '$1')
					.replace(/,{2,}/g, ',')
					.replace(/,$/, '');
			return strip(proxied) === strip(native);
		},
	],
	[
		/^(worker-|shared-worker$)/,
		/^G\.WorkerGlobalScope\.prototype\.fetch$/,
		"OPEN: fetch called on what is no scope rejects with the browser's own error a turn late, so its stack is not the call's",
	],
];

// Realms the proxy does not yet show as the browser does, each with what
// is known of why: compared and counted all the same, reported as OPEN
// lines, and failed only once they read as natively (the entry is then
// stale and has to go).
const OPEN_REALMS = new Map([
	[
		'frame-detached',
		"a removed frame's window: natively its interface objects read undefined once the frame is gone; the ones the inject touched while it hooked the frame are still there",
	],
	[
		'frame-data',
		"a data: document is no secure context natively and lacks every API that needs one; the proxy serves it from its own origin, a secure context with all of them; and an about:blank frame it makes is its own natively, where through the proxy reading the frame's Function is refused as another origin's (walker:fresh-frame)",
	],
	[
		'inert-documents',
		"nodes of a document without a window (createHTMLDocument, DOMParser, a template's): their URL properties resolve against the page, where natively such a document is about:blank or has a base of its own",
	],
	[
		'sandbox-scripts',
		"a sandboxed frame without allow-same-origin: natively it has no Navigation API entries, Notification.permission is denied and fullscreen is off, and its storage refuses a call only after the receiver and the arguments are checked; the proxy's sandbox answers some of these its own way",
	],
	[
		'frame-javascript',
		"the document a javascript: URL's string makes is about:blank natively (its location, document.URL, its navigation entry); the proxy shows it at the URL of the page that made it",
	],
	[
		'service-worker',
		"the emulated service worker's scope: its stand-in interfaces (Client, Clients, the Extendable events) are not yet shaped as the browser's",
	],
]);
// Realms the demo host does not let a page make.
const NOT_MADE = new Map([
	[
		'popup-url',
		"the demo host opens a page's popup as a tab of its own (config.openTab) and tells the page null, as a popup blocker does",
	],
]);

const REALMS = {
	frames: [
		'top',
		'frame-same-origin',
		'frame-cross-origin',
		'frame-srcdoc',
		'blank-sync',
		'blank-loaded',
		'frame-written',
		'frame-detached',
		'object-document',
		'embed-document',
		'sandbox-scripts',
		'sandbox-same-origin',
		'frame-data',
		'frame-javascript',
		'inert-documents',
	],
	popups: ['top', 'popup-blank-sync', 'popup-blank-loaded', 'popup-url'],
	workers: [
		'worker-classic',
		'worker-module',
		'worker-blob-classic',
		'worker-blob-module',
		'worker-nested',
		'shared-worker',
		'service-worker',
		'audio-worklet',
		'paint-worklet',
	],
	worklets: ['layout-worklet', 'animation-worklet'],
};

const target = (set) =>
	`${FIXTURE}pages/realm-surface.html?set=${set}${ONLY ? `&only=${ONLY}` : ''}&avoid=${encodeURIComponent(JSON.stringify(AVOID))}`;

/**
 * The records of the worklets that send nothing but their console (paint,
 * layout, animation), from the lines each leaves as: `realm-surface-<kind>
 * <id> <index> <count> <part>`. `heard` takes a line from elsewhere than the
 * page's console (workletConsoles).
 */
function workletRecords(page) {
	const parts = new Map();
	const records = { paint: [], layout: [], animation: [] };
	const heard = (text) => {
		const kind = /^realm-surface-(paint|layout|animation) /.exec(text)?.[1];
		if (!kind) return;
		const [prefix, id, index, count] = text.split(' ', 4);
		const body = text.slice(`${prefix} ${id} ${index} ${count} `.length);
		const list = parts.get(id) ?? [];
		parts.set(id, list);
		list[Number(index)] = body;
		if (list.filter((part) => part !== undefined).length === Number(count))
			try {
				records[kind].push(JSON.parse(list.join('')));
			} catch (error) {
				records[kind].push({ error: `unreadable record: ${error.message}` });
			}
	};
	page.on('console', (message) => heard(message.text()));
	return { records, heard };
}

/**
 * An animation worklet's console reaches no page: its lines are read from
 * the worklet's DevTools target, attached wherever the worklet is made (the
 * page, or a frame of another process, and that frame's frames), each
 * target told to go on once it is watched.
 */
async function workletConsoles(page, heard) {
	const session = await page.context().newCDPSession(page);
	let ids = 0;
	const watch = (send, on) => {
		const children = new Map();
		on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
			const listeners = new Map();
			children.set(sessionId, (message) => {
				if (message.method) listeners.get(message.method)?.(message.params);
			});
			const childSend = (method, params = {}) =>
				send('Target.sendMessageToTarget', {
					sessionId,
					message: JSON.stringify({ id: ++ids, method, params }),
				});
			const childOn = (method, listener) => listeners.set(method, listener);
			if (targetInfo.type === 'worklet') {
				childOn('Runtime.consoleAPICalled', ({ args }) =>
					heard(args.map((arg) => arg.value).join(' ')),
				);
				childSend('Runtime.enable');
			} else watch(childSend, childOn);
			childSend('Runtime.runIfWaitingForDebugger');
		});
		on('Target.receivedMessageFromTarget', ({ sessionId, message }) =>
			children.get(sessionId)?.(JSON.parse(message)),
		);
		send('Target.setAutoAttach', {
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: false,
			filter: [{ type: 'iframe' }, { type: 'worklet' }],
		});
	};
	watch(
		(method, params) => session.send(method, params).catch(() => {}),
		(method, listener) => session.on(method, listener),
	);
}

/** the page's state once it is done, from the frame `find` picks */
async function collect(find, records) {
	for (let i = 0; i < 1200; i++) {
		await sleep(250);
		const frame = await find();
		const text = await frame
			?.evaluate(() =>
				window.__realmSurface?.done
					? JSON.stringify(window.__realmSurface)
					: (window.__realmSurface?.waiting ?? null),
			)
			.catch(() => null);
		if (!text) continue;
		// the page waits for a click (a popup takes one)
		if (!text.startsWith('{')) {
			await frame.click(`#${text}`, { timeout: 5000 }).catch(() => {});
			continue;
		}
		const state = JSON.parse(text);
		for (const kind in records) {
			const realm = `${kind}-worklet`;
			if (!state.realms[realm]?.console) continue;
			// (a worklet walks for seconds after its module is added)
			for (let j = 0; j < 120 && !records[kind].length; j++) await sleep(250);
			state.realms[realm] = records[kind][0] ?? {
				error: 'no console record',
			};
		}
		return state;
	}
	return null;
}

/** every fact of a realm's record: its own, or its base's with what differs */
const facts = (state, name) => {
	const realm = state?.realms[name];
	if (!realm || realm.error) return null;
	if (realm.lines) return realm.lines;
	const base = state.realms[state.bases[name]]?.lines;
	if (!base) return null;
	const out = { ...base, ...realm.changed };
	for (const key of realm.missing) delete out[key];
	return out;
};

const same = (a, b) =>
	a.key === b.key && a.native === b.native && a.proxied === b.proxied;

/**
 * What differs between the native record of a realm and the proxied one:
 * facts the two native loads agree on, less what EXCLUDED lists
 */
function compare(realm, first, second, proxied, mode) {
	const a = facts(first, realm);
	const b = facts(second, realm);
	const p = facts(proxied, realm);
	const result = {
		differences: [],
		volatile: 0,
		excluded: new Map(),
		facts: 0,
	};
	if (!a || !p) return result;
	result.facts = Object.keys(a).length;
	const excluded = (key, native, through) =>
		EXCLUDED.find(
			([realms, pattern, , only, when]) =>
				realms.test(realm) &&
				pattern.test(key) &&
				(!only || only === mode) &&
				(!when || when(native, through)),
		);
	const differ = (key, native, through) => {
		const rule = excluded(key, native, through);
		if (rule) {
			result.excluded.set(rule[2], (result.excluded.get(rule[2]) ?? 0) + 1);
			return;
		}
		result.differences.push({ key, native, proxied: through });
	};
	for (const key in a) {
		if (b && a[key] !== b[key]) {
			result.volatile++;
			continue;
		}
		if (!(key in p)) differ(key, a[key], undefined);
		else if (p[key] !== a[key]) differ(key, a[key], p[key]);
	}
	for (const key in p)
		if (!(key in a) && !(b && key in b)) differ(key, undefined, p[key]);
	return result;
}

const show = (difference) =>
	`${difference.key}: ${String(difference.native).slice(0, 160)} -> ${String(difference.proxied).slice(0, 160)}`;

const browser = await launch();
// the browser the worklets behind a blink feature are walked in
const flagged = SETS.includes('worklets')
	? await launch(['--enable-blink-features=CSSLayoutAPI,AnimationWorklet'])
	: null;
const browserOf = (set) => (set === 'worklets' ? flagged : browser);
if (DUMP) mkdirSync(DUMP, { recursive: true });
const dump = (name, value) => {
	if (DUMP) writeFileSync(`${DUMP}/${name}.json`, JSON.stringify(value));
};
const errors = [];

/** the page loaded natively, in a context of its own, with a real window */
async function native(set) {
	// (nothing of one load, a registration or storage, is there for the
	// next; and no emulated viewport, which makes the screen the viewport)
	const context = await browserOf(set).newContext({ viewport: null });
	const page = await context.newPage();
	const { records, heard } = workletRecords(page);
	if (set === 'worklets') await workletConsoles(page, heard);
	const raised = [];
	page.on('pageerror', (error) => raised.push(error.message));
	await page.goto(target(set));
	const state = await collect(async () => page.mainFrame(), records);
	await context.close();
	return { state, raised };
}

/** the page loaded through the proxy in one demo mode */
async function through(set, base) {
	await waitForServer(base);
	const context = await browserOf(set).newContext({ viewport: null });
	const page = await context.newPage();
	const raised = [];
	page.on('pageerror', (error) => raised.push(error.message));
	const { records, heard } = workletRecords(page);
	if (set === 'worklets') await workletConsoles(page, heard);
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	// what the worker served (Playwright reports no worklet's module request)
	await page.evaluate(() => {
		window.__served = [];
		window.controller.addEventListener('request', (event) =>
			window.__served.push(event.detail.url),
		);
	});
	await submitLanding(page, target(set));
	const state = await collect(
		async () =>
			page.frames().find((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
		records,
	);
	const served = await page.evaluate(() => window.__served).catch(() => []);
	await context.close();
	return { state, raised, served };
}

const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];
for (const set of SETS) {
	// the loads of a set side by side: each walks for seconds
	const [one, two, ...proxied] = await Promise.all([
		native(set),
		native(set),
		...MODES.map(([, base]) => through(set, base)),
	]);
	const first = one.state;
	const second = two.state;
	dump(`${set}-native1`, first);
	dump(`${set}-native2`, second);
	ok(
		`${set}: natively, the page walks every realm`,
		!!first && !!second,
		first
			? Object.entries(first.realms)
					.map(([name, realm]) =>
						realm.error
							? `${name}: ${String(realm.error).slice(0, 120)}`
							: `${name} ${first.counts[name]?.properties ?? ''}`,
					)
					.join(', ')
			: 'no record',
	);
	if (!first || !second) continue;
	for (const [index, [mode]] of MODES.entries()) {
		const { state, raised, served } = proxied[index];
		dump(`${set}-${mode}`, state);
		if (
			!ok(
				`${mode}: ${set}: the page walks its realms through the proxy`,
				!!state,
			)
		)
			continue;
		if (set === 'worklets' && !ONLY)
			ok(
				`${mode}: the layout and animation worklets' modules went through the proxy`,
				['layout', 'animation'].every((kind) =>
					served.some((url) =>
						url.endsWith(`/pages/realm-surface-${kind}-worklet.js`),
					),
				),
				JSON.stringify(served.filter((url) => /worklet|walker/.test(url))),
			);
		const all = {};
		for (const realm of REALMS[set]) {
			if (ONLY && !ONLY.split(',').includes(realm) && realm !== 'top') continue;
			const natively = first.realms[realm];
			const reached = state.realms[realm];
			if (!natively || natively.error) {
				// a realm this browser cannot make is no realm to compare
				console.log(
					`SKIP ${mode}: ${realm}: not walked natively (${String(natively?.error).slice(0, 200)})`,
				);
				continue;
			}
			if (!reached || reached.error) {
				const why = NOT_MADE.get(realm) ?? OPEN_REALMS.get(realm);
				if (why)
					console.log(
						`${NOT_MADE.has(realm) ? 'SKIP' : 'OPEN'} ${mode}: ${realm}: not walked through the proxy (${String(reached?.error).slice(0, 160)}): ${why}`,
					);
				else
					ok(
						`${mode}: ${realm} reads as natively`,
						false,
						`not walked through the proxy: ${String(reached?.error).slice(0, 600)}`,
					);
				continue;
			}
			const result = compare(realm, first, second, state, mode);
			// a difference of the realm's base is the base's to report
			const baseDifferences = all[state.bases[realm]];
			if (baseDifferences) {
				const before = result.differences.length;
				result.differences = result.differences.filter(
					(difference) =>
						!baseDifferences.some((other) => same(difference, other)),
				);
				result.shared = before - result.differences.length;
			}
			all[realm] = result.differences;
			const left = [...result.excluded]
				.map(([reason, count]) => `${count} left out (${reason})`)
				.join('; ');
			if (NOT_MADE.has(realm) || OPEN_REALMS.has(realm)) {
				if (result.differences.length) {
					console.log(
						`OPEN ${mode}: ${realm}: ${result.differences.length} of ${result.facts} facts differ (${OPEN_REALMS.get(realm) ?? NOT_MADE.get(realm)}); the first: ${result.differences.slice(0, 3).map(show).join(' | ')}`,
					);
					continue;
				}
				ok(
					`${mode}: ${realm} is listed as open, and still differs`,
					false,
					'it reads as natively now: take it off the list',
				);
				continue;
			}
			ok(
				`${mode}: ${realm} reads as natively`,
				result.differences.length === 0,
				`${result.facts} facts compared, ${state.counts[realm]?.properties ?? '?'} properties walked` +
					`${result.volatile ? `, ${result.volatile} that change natively left out` : ''}${left ? `, ${left}` : ''}` +
					`${result.shared ? `, ${result.shared} differences shared with ${state.bases[realm]}` : ''}` +
					(result.differences.length
						? `; ${result.differences.length} differ: ${result.differences.slice(0, 12).map(show).join(' | ')}`
						: ''),
			);
		}
		if (set === 'frames')
			for (const [name, realm, label] of [
				[
					'identity',
					'frame-same-origin',
					'objects of a frame and of the page are whose they are natively',
				],
				[
					'fresh',
					'blank-sync',
					'a function taken from a frame the moment it exists reads as natively',
				],
			]) {
				if (ONLY && !ONLY.split(',').includes(realm)) continue;
				const a = JSON.stringify(first[name]);
				const b = JSON.stringify(state[name]);
				ok(
					`${mode}: ${label}`,
					a === b && a !== undefined,
					a === b ? '' : `native ${a} proxied ${b}`,
				);
			}
		dump(`${set}-${mode}-differences`, all);
		const extra = proxiedOnlyErrors(one.raised, raised);
		ok(
			`${mode}: ${set}: the page raises no error it does not raise natively`,
			extra.length === 0,
			JSON.stringify(extra).slice(0, 1500),
		);
	}
}
await flagged?.close();
await done(browser, errors);
