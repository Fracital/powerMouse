// Every way a proxied page can obtain a window of another site, and what the
// reference lets it do. Every proxied site shares the proxy's one real origin
// (in both demo modes: isolated mode keeps the host apart, not one proxied
// site from another), so the browser's own cross-origin checks never fire
// between them: isolation rests on the inject handing the page a restricted
// stand-in, never the raw window. The fixture (window-refs.html) has a child
// of another site, a sibling of its own site (another site to the child), a
// frameset frame, an <object> and an <embed>, a frame held from about:blank
// before it went to another site, a frame window.open() navigates by name,
// and a popup held from about:blank; the child, the sibling and the popup
// probe their parent, sibling and opener. Each path's verdict is compared
// with the same pages loaded natively, where every read, call and write of
// another site's window throws SecurityError.
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

const target = `${FIXTURE}pages/window-refs.html`;
const ROLES = ['top', 'child', 'sib', 'popup', 'frameset'];

// Paths that still hand out another site's raw window, by role (see "Window
// references" in docs/scramjet-parity.md). Each is asserted raw, so a fix
// shows up here and the list must shrink with it.
const KNOWN_OPEN = {
	top: [
		// a window the page reached while it was of its own origin (the
		// browser's WindowProxy keeps its identity; the stand-in cannot
		// replace an object the page already holds)
		'heldFrame',
		'heldFrameContentWindow',
		'heldFrameIndex',
		'heldPopup',
		'heldPopupSource',
		'popupMessageSource',
		// native copies of a window's children, and the document's named
		// iframe (its named properties come before anything definable)
		'slice',
		'forEach',
		'spread',
		'documentName',
	],
	sib: ['parentDocumentKid'],
};

// The held frame again, handed back by its own realm while it was of this
// page's origin (its evaluator's `window`, its Function's `this`, its
// document's defaultView, its own `self` and `frames`, an event's
// currentTarget): the WindowProxy itself, which shows whatever document the
// window navigates to. A membrane over the window references the page holds
// cannot see these; only one over every object crossing between the realms
// can. Asserted raw on their own, apart from KNOWN_OPEN.
const EXTRACTION = {
	top: [
		'extractEval',
		'extractArray',
		'extractFunction',
		'extractDefaultView',
		'extractSelf',
		'extractFrames',
		'extractCurrentTarget',
	],
};

/** every report of the fixture's documents, by role, from every page of the context */
async function collect(context) {
	const reports = {};
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const page of context.pages())
			for (const frame of page.frames()) {
				const value = await frame
					?.evaluate(() => window.__refs)
					.catch(() => null);
				if (value?.role && value.done) reports[value.role] = value;
			}
		if (ROLES.every((role) => reports[role])) break;
	}
	return reports;
}

const browser = await launch();
const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
await nativePage.goto(target);
const native = await collect(nativeContext);
await nativeContext.close();
ok(
	'natively, every document reports',
	ROLES.every((role) => native[role]) && !native.top.timedOut,
	JSON.stringify(Object.keys(native)),
);
// the browser's own verdicts the comparison rests on
ok(
	'natively, another site reached by index, by name and through its element is restricted',
	['framesIndex', 'bareName', 'contentWindow', 'heldFrame', 'heldPopup'].every(
		(path) => native.top?.paths[path] === 'restricted',
	) && native.top?.paths.contentDocument === 'null',
	JSON.stringify(native.top?.paths),
);

const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await collect(page.context());
	for (const role of ROLES) {
		const nativePaths = native[role]?.paths ?? {};
		const proxiedPaths = proxied[role]?.paths ?? {};
		ok(
			`${mode}: the ${role} document reports`,
			!!proxied[role] && !proxied[role].timedOut,
			JSON.stringify(Object.keys(proxied)),
		);
		for (const path of Object.keys(nativePaths)) {
			const detail = JSON.stringify({
				native: nativePaths[path],
				proxied: proxiedPaths[path],
			});
			if (EXTRACTION[role]?.includes(path))
				ok(
					`${mode}: ${role} ${path} is still raw (extraction)`,
					!String(nativePaths[path]).startsWith('RAW') &&
						String(proxiedPaths[path]).startsWith('RAW'),
					detail,
				);
			else if (KNOWN_OPEN[role]?.includes(path))
				ok(
					`${mode}: ${role} ${path} is still raw (known open)`,
					!String(nativePaths[path]).startsWith('RAW') &&
						String(proxiedPaths[path]).startsWith('RAW'),
					detail,
				);
			else
				ok(
					`${mode}: ${role} ${path} as natively`,
					proxiedPaths[path] === nativePaths[path],
					detail,
				);
		}
	}
	errors.push(...page.errors);
	await page.context().close();
}
await done(browser, errors);
