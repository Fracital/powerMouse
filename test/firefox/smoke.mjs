// STomp's demo in Firefox (npm run test:firefox): a headless Firefox on a
// fresh profile (test/firefox/bidi.mjs, WebDriver BiDi) against a demo
// server and fixture site of its own (servers.mjs). In order:
//  - boot: the landing says Ready with no error in the console, the proxy's
//    service worker is registered, the controller handshook;
//  - a fixture page proxied, compared with the same page loaded natively
//    (test/pages/firefox-smoke.html: title, element count, cookies, a
//    fetch's Cookie header, localStorage, a synchronous XMLHttpRequest
//    through the sync bridge, a WebSocket echo, a frame, a worker, a form),
//    in the isolated mode (localhost, the proxy on 127.0.0.1) and the
//    same-origin one;
//  - real sites render (Wikipedia, MDN, the Chrome Web Store, Hacker News;
//    SKIP_NETWORK=1 leaves them out);
//  - the toolbar's Back and Forward and a reload of the host page with the
//    `?N` top-URL tokens, the browser's own Back and Forward, Ctrl+R;
//  - themes and Page appearance (a proxied page's prefers-color-scheme);
//  - Stop on a slow load;
//  - the Extensions page opens;
//  - the Tor box is unavailable with no relay;
//  - offline.html's Download saves the file, which boots from file: and
//    loads the fixture;
//  - Tor mode (a second demo server whose Tor relay is the first one's
//    wisp): the box offered, a page loads, the normal profile's site data
//    is not in Tor's, and turned off the ordinary scope is back;
//  - dialing (?mode=just-call-stomp) on content slots: the fixture page
//    loads in a frame whose URL names nothing.
// Each check prints PASS or FAIL as a suite's do; a difference Firefox
// still has is listed in KNOWN with its reason and passes as known, and a
// listed check that passes again fails, so the entry goes when a fix lands.
// Not in CI (no Firefox there): it says SKIP and exits 0 where Firefox is
// missing, and under CI unless FIREFOX names a binary. SHOTS=1 keeps
// screenshots in test/out/firefox-*.png.
/* global ISOLATED, PMTheme, openExtensionsPage, DIRECTORY, TOR_REQUESTED -- the demo page's, in the functions evaluated there */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firefoxBinary, launchFirefox } from './bidi.mjs';
import { startServers } from './servers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${root}test/out/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!firefoxBinary() || (process.env.CI && !process.env.FIREFOX)) {
	console.log(
		`SKIP firefox smoke: ${firefoxBinary() ? 'CI (FIREFOX names a binary to run it there)' : 'no firefox (FIREFOX names one)'}`,
	);
	process.exit(0);
}
if (!existsSync(`${root}dist/serviceWorker.js`)) {
	console.error('dist/ is missing: run `npm run build` first');
	process.exit(2);
}

// Differences Firefox still has, by check name, with why
const KNOWN = {};

let passed = 0;
let failed = 0;
let known = 0;
function ok(name, condition, detail = '') {
	const reason = KNOWN[name];
	if (reason && !condition) {
		known++;
		console.log(
			`PASS ${name} (known open: ${reason})${detail ? ` - ${detail}` : ''}`,
		);
		return false;
	}
	if (reason && condition) {
		failed++;
		console.log(
			`FAIL ${name} passes again: take it off KNOWN${detail ? ` - ${detail}` : ''}`,
		);
		return true;
	}
	if (condition) passed++;
	else failed++;
	console.log(
		(condition ? 'PASS ' : 'FAIL ') + name + (detail ? ` - ${detail}` : ''),
	);
	return !!condition;
}
const short = (value, max = 600) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text && text.length > max ? `${text.slice(0, max)}...` : text;
};

const servers = await startServers();
const firefox = await launchFirefox();
console.log(
	`# Firefox ${firefox.version}, demo :${servers.port}, fixture :${servers.fixturePort}`,
);
const shot = async (tab, name) => {
	if (!process.env.SHOTS) return;
	mkdirSync(OUT, { recursive: true });
	await tab.screenshot(`${OUT}firefox-${name}.png`).catch(() => {});
};
// What Firefox prints natively for the same thing, and so is no error of
// the proxy's: a service worker's answer to a navigation that is a redirect
// (`new Response(null, { status: 307, headers: { location } })` or
// Response.redirect()) is followed, and Firefox 160 still reports
// "Failed to load ''" for it in the page's console (a GET form's
// submission is sealed by one, src/server/rewrites.ts html:form)
const NATIVE_NOISE = [
	/^Failed to load \u2018\u2019\. A ServiceWorker intercepted the request and encountered an unexpected error\.$/,
];
/** the console's errors since `from` (an index into firefox.logs) */
const errorsSince = (from) =>
	firefox.logs
		.slice(from)
		.filter((entry) => entry.level === 'error')
		.filter((entry) => !NATIVE_NOISE.some((noise) => noise.test(entry.text)))
		.map(
			(entry) =>
				`${entry.type}: ${entry.text}${entry.stack ? ` (${entry.stack})` : ''}`,
		);

const LANDING = () => document.getElementById('logMsg')?.textContent ?? '';

/** the demo at `base` in a new tab, until its landing says Ready or Error */
async function openDemo(base) {
	const tab = await firefox.newTab();
	await tab.go(base);
	const status = await tab.until(
		() => {
			const text = document.getElementById('logMsg')?.textContent ?? '';
			return /^(Ready|Error)/.test(text) ? text : null;
		},
		{ timeout: 60000, args: [] },
	);
	return { tab, status: status ?? (await tab.eval(LANDING).catch(() => null)) };
}

/** type `url` into the landing's form (opens a new tab of the demo) */
const submitLanding = (tab, url) =>
	tab.eval((u) => {
		const form = document.getElementById('mainForm');
		form.url.value = u;
		form.requestSubmit();
	}, url);
const submitOmni = (tab, url) =>
	tab.eval((u) => {
		const form = document.getElementById('omni');
		form.url.value = u;
		form.requestSubmit();
	}, url);
const omni = (tab) =>
	tab.eval(() => document.querySelector('#omni input').value);
const topSearch = (tab) => tab.eval(() => location.search);
/** the top's token once the demo has written one other than `not` (it writes it as the page commits, a moment after the frame shows it) */
const topToken = (tab, not = '') =>
	tab
		.until(
			(old) =>
				/^\?\d+$/.test(location.search) && location.search !== old
					? location.search
					: null,
			{ timeout: 5000, args: [not] },
		)
		.then((token) => token ?? topSearch(tab));

const REPORT = () => window.__ffReport ?? null;

async function fixtureReport(tab) {
	const found = await tab.find(REPORT, { timeout: 60000, skipTop: true });
	return found ? { ...found, value: JSON.parse(found.value) } : null;
}

// ---- boot and the fixture page, in each mode ----

const SMOKE = `${servers.fixture}pages/firefox-smoke.html`;
const native = await firefox.newTab();
await native.go(SMOKE);
const nativeFound = await native.find(REPORT, { timeout: 60000 });
const nativeReport = nativeFound ? JSON.parse(nativeFound.value) : null;
ok('the fixture page reports natively', !!nativeReport, short(nativeReport));
await native.close();

const MODES = [
	['isolated', servers.host],
	['same-origin', servers.proxy],
];
let main = null;
for (const [mode, base] of MODES) {
	const from = firefox.logs.length;
	const { tab, status } = await openDemo(base);
	ok(`${mode}: the landing says Ready`, status === 'Ready', status);
	const facts = await tab
		.eval(() => ({
			isolated: typeof ISOLATED === 'undefined' ? null : ISOLATED,
			codec: window.controller?.config?.codec ?? null,
			directory: window.controller?.config?.directory ?? null,
			badges: [...document.querySelectorAll('.badge, [data-badge]')]
				.map((b) => b.textContent.trim())
				.slice(0, 12),
		}))
		.catch((error) => ({ error: error.message }));
	ok(
		`${mode}: the controller handshook (it has its config and address)`,
		!!facts.codec && !!facts.directory,
		short(facts),
	);
	// the proxy's service worker: on the host's origin in the same-origin
	// mode, on 127.0.0.1 in the controller's frame in the isolated one
	const proxyOrigin = new URL(servers.proxy).origin;
	const registered = await tab.find(
		async (origin) => {
			if (location.origin !== origin) return null;
			const registrations = await navigator.serviceWorker.getRegistrations();
			const scopes = registrations.filter((r) => r.active).map((r) => r.scope);
			return scopes.some((scope) => /\/stomp\//.test(scope)) ? scopes : null;
		},
		{ timeout: 20000, args: [proxyOrigin] },
	);
	ok(
		`${mode}: the proxy's service worker is registered and active`,
		!!registered,
		short(registered?.value),
	);
	await sleep(500);
	if (mode === 'isolated') {
		// the installed app's worker (demo/README.md "The installed app") is
		// registered only where the browser offers an install
		// (BeforeInstallPromptEvent, which Firefox does not have)
		const app = await tab.eval(async () => ({
			prompt: 'BeforeInstallPromptEvent' in window,
			manifest: !!document.querySelector('link[rel="manifest"]'),
			workers: (await navigator.serviceWorker.getRegistrations()).map(
				(r) => r.scope,
			),
		}));
		ok(
			'the app worker is left out where the browser has no install prompt',
			app.prompt ||
				!app.workers.some((scope) => new URL(scope).pathname === '/'),
			short(app),
		);
	}
	const bootErrors = errorsSince(from);
	ok(
		`${mode}: no console errors as the demo boots`,
		!bootErrors.length,
		short(bootErrors, 2000),
	);
	await shot(tab, `${mode}-landing`);

	const loadFrom = firefox.logs.length;
	await submitLanding(tab, SMOKE);
	const found = await fixtureReport(tab);
	ok(
		`${mode}: the fixture page reports through the proxy`,
		!!found,
		found ? found.url : 'no report',
	);
	if (found && nativeReport) {
		for (const key of Object.keys(nativeReport)) {
			const a = JSON.stringify(nativeReport[key]);
			const b = JSON.stringify(found.value[key]);
			ok(
				`${mode}: fixture ${key} reads as natively`,
				a === b,
				`native ${a}, proxied ${b}`,
			);
		}
		ok(
			`${mode}: the frame is not on the fixture's origin`,
			!found.url.startsWith(servers.fixture),
			found.url,
		);
	}
	const loadErrors = errorsSince(loadFrom);
	ok(
		`${mode}: no console errors as the fixture page loads`,
		!loadErrors.length,
		short(loadErrors, 2000),
	);
	await shot(tab, `${mode}-fixture`);
	if (mode === 'isolated') main = tab;
	else await tab.close();
}

// ---- helpers for the browser view ----

const ACTIVE = '.frame:not(.hidden)';
/** fn(...args) in the active tab's proxied frame */
async function inActive(tab, fn, ...args) {
	const context = await tab.frameOf(ACTIVE);
	if (!context) throw new Error('no active frame');
	return tab.in(context, fn, ...args);
}
/** wait until fn holds in the active tab's frame: its value, or null */
async function waitActive(tab, fn, { timeout = 40000, args = [] } = {}) {
	const end = Date.now() + timeout;
	do {
		try {
			const value = await inActive(tab, fn, ...args);
			if (value) return value;
		} catch (error) {
			// navigating
		}
		await sleep(250);
	} while (Date.now() < end);
	return null;
}
const TITLE = () => document.title;

// ---- real sites ----

if (process.env.SKIP_NETWORK === '1')
	console.log('SKIP real sites (SKIP_NETWORK=1)');
else {
	// each probe reads the page's own URL first (document.URL, which the
	// inject answers as the page reads it): the frame shows the page before
	// until the next one commits
	const SITES = [
		[
			'Wikipedia',
			'https://en.wikipedia.org/wiki/Web_proxy',
			() => {
				if (new URL(document.URL).hostname !== 'en.wikipedia.org') return null;
				const heading = document.querySelector('#firstHeading')?.textContent;
				const links = document.querySelectorAll('#bodyContent a').length;
				return heading && links > 50
					? { heading, links, url: document.URL }
					: null;
			},
		],
		[
			'MDN',
			'https://developer.mozilla.org/en-US/docs/Web/HTML',
			() => {
				if (new URL(document.URL).hostname !== 'developer.mozilla.org')
					return null;
				const heading = document.querySelector('main h1')?.textContent;
				const styled = getComputedStyle(document.body).fontFamily;
				return heading && document.styleSheets.length > 0
					? { heading, styled, url: document.URL }
					: null;
			},
		],
		[
			'the Chrome Web Store',
			'https://chromewebstore.google.com/',
			() => {
				if (new URL(document.URL).hostname !== 'chromewebstore.google.com')
					return null;
				const links = document.querySelectorAll('a[href*="/detail/"]').length;
				return links > 5
					? { links, title: document.title, url: document.URL }
					: null;
			},
		],
		[
			'Hacker News',
			'https://news.ycombinator.com/',
			() => {
				if (new URL(document.URL).hostname !== 'news.ycombinator.com')
					return null;
				const stories = document.querySelectorAll('.athing').length;
				return stories >= 20 ? { stories, url: document.URL } : null;
			},
		],
	];
	for (const [name, url, probe] of SITES) {
		await submitOmni(main, url);
		const seen = await waitActive(main, probe, { timeout: 60000 });
		ok(`${name} renders through the proxy`, !!seen, short(seen));
		await shot(main, `site-${name.replace(/\W+/g, '-').toLowerCase()}`);
	}
}

// ---- Back, Forward and reload with the ?N tokens ----

{
	const { tab, status } = await openDemo(servers.host);
	ok('navigation: a second demo tab says Ready', status === 'Ready', status);
	await submitLanding(tab, `${servers.fixture}pages/walk-1.html`);
	const first = await waitActive(tab, () =>
		document.title === 'WALK 1' ? location.href : null,
	);
	const token1 = await topToken(tab);
	ok(
		'navigation: walk-1 loads, the top URL is a token',
		!!first && /^\?\d+$/.test(token1),
		`${first} ${token1}`,
	);
	// (a click of the user's: Chrome's history intervention passes over an
	// entry whose document navigated by script without one, and the demo
	// does as Chrome does)
	await tab.activeIn(await tab.frameOf(ACTIVE), () =>
		document.getElementById('next').click(),
	);
	const second = await waitActive(tab, () =>
		document.title === 'WALK 2' ? location.href : null,
	);
	const token2 = await topToken(tab, token1);
	ok(
		"navigation: a link of the page's loads walk-2 under a token of its own",
		!!second && /^\?\d+$/.test(token2) && token2 !== token1,
		`${second} ${token1} -> ${token2}`,
	);
	ok(
		'navigation: the address bar shows the real URL',
		(await omni(tab)) === `${servers.fixture}pages/walk-2.html`,
		await omni(tab),
	);
	await tab.click('#toolBack');
	const back = await waitActive(tab, () =>
		document.title === 'WALK 1' ? location.href : null,
	);
	await sleep(500);
	ok(
		"navigation: the toolbar's Back shows walk-1 at its token",
		!!back && (await topSearch(tab)) === token1,
		`${back} ${await topSearch(tab)}`,
	);
	await tab.click('#toolForward');
	const forward = await waitActive(tab, () =>
		document.title === 'WALK 2' ? location.href : null,
	);
	await sleep(500);
	ok(
		"navigation: the toolbar's Forward shows walk-2 at its token",
		!!forward && (await topSearch(tab)) === token2,
		`${forward} ${await topSearch(tab)}`,
	);
	await firefox.send('browsingContext.traverseHistory', {
		context: tab.context,
		delta: -1,
	});
	const browserBack = await waitActive(tab, () =>
		document.title === 'WALK 1' ? location.href : null,
	);
	await sleep(500);
	ok(
		"navigation: the browser's Back shows walk-1 at its token",
		!!browserBack && (await topSearch(tab)) === token1,
		`${browserBack} ${await topSearch(tab)}`,
	);
	await firefox.send('browsingContext.traverseHistory', {
		context: tab.context,
		delta: 1,
	});
	const browserForward = await waitActive(tab, () =>
		document.title === 'WALK 2' ? location.href : null,
	);
	await sleep(500);
	ok(
		"navigation: the browser's Forward shows walk-2 at its token",
		!!browserForward && (await topSearch(tab)) === token2,
		`${browserForward} ${await topSearch(tab)}`,
	);
	const reloadFrom = firefox.logs.length;
	await tab.reload();
	const reloaded = await waitActive(
		tab,
		() => (document.title === 'WALK 2' ? location.href : null),
		{ timeout: 60000 },
	);
	ok(
		'navigation: a reload of the host brings walk-2 back at its token',
		!!reloaded && (await topSearch(tab)) === token2,
		`${reloaded} ${await topSearch(tab)}`,
	);
	const reloadErrors = errorsSince(reloadFrom);
	ok(
		'navigation: no console errors on the reload',
		!reloadErrors.length,
		short(reloadErrors, 2000),
	);

	// ---- Stop and the keys ----

	const origin = await tab.eval(() => performance.timeOrigin);
	await inActive(tab, () => (window.__ffMark = 1));
	await tab.eval(() => document.querySelector('#omni input').focus());
	await tab.keys(['r'], ['\uE009']);
	const markGone = await waitActive(
		tab,
		() =>
			window.__ffMark === undefined && document.title === 'WALK 2'
				? 'reloaded'
				: null,
		{ timeout: 20000 },
	);
	ok(
		"keys: Ctrl+R in the address bar reloads the tab's page, not the demo",
		!!markGone && (await tab.eval(() => performance.timeOrigin)) === origin,
		`${markGone} ${origin} ${await tab.eval(() => performance.timeOrigin)}`,
	);
	await submitOmni(tab, `${servers.fixture}slow-page?ms=9000`);
	const stopping = await tab.until(
		() => document.getElementById('toolReload').classList.contains('stopping'),
		{ timeout: 5000 },
	);
	ok('Stop: a slow load shows Stop', !!stopping);
	await tab.click('#toolReload');
	await sleep(1000);
	const afterStop = await tab.eval(() => ({
		stopping: document
			.getElementById('toolReload')
			.classList.contains('stopping'),
		label: document.getElementById('toolReload').getAttribute('aria-label'),
	}));
	ok(
		'Stop: pressing it ends the load (Reload again)',
		!afterStop.stopping,
		short(afterStop),
	);
	await sleep(9000);
	const stoppedTitle = await inActive(tab, TITLE).catch(
		(error) => error.message,
	);
	ok(
		'Stop: the slow page never arrives',
		stoppedTitle !== 'SLOW',
		stoppedTitle,
	);

	// ---- themes and Page appearance ----

	await submitOmni(tab, `${servers.fixture}pages/walk-3.html`);
	await waitActive(tab, () => document.title === 'WALK 3');
	await tab.click('#toolMenu');
	await sleep(300);
	await tab.click('#menuSettings');
	const settings = await tab.until(
		() => !!document.querySelector('.spThemePick[data-theme="dark"]'),
		{ timeout: 5000 },
	);
	ok('themes: Settings opens with the theme picker', !!settings);
	const before = await tab.eval(
		() => getComputedStyle(document.body).backgroundColor,
	);
	await tab.click('.spThemePick[data-theme="dark"]');
	await sleep(500);
	const dark = await tab.eval(() => ({
		theme: PMTheme.current().id,
		attribute: document.documentElement.getAttribute('data-pm-theme'),
		scheme: getComputedStyle(document.documentElement).colorScheme,
		kept: localStorage.getItem('stomp-demo:theme'),
	}));
	ok(
		'themes: Dark is chosen and kept',
		dark.theme === 'dark' && dark.kept === 'dark',
		short({ before, ...dark }),
	);
	for (const mode of ['dark', 'light']) {
		await tab.click(`.spModePick[data-page-mode="${mode}"]`);
		await sleep(500);
		const seen = await inActive(
			tab,
			() => matchMedia('(prefers-color-scheme: dark)').matches,
		);
		ok(
			`Page appearance: ${mode} is what the proxied page's prefers-color-scheme reads`,
			seen === (mode === 'dark'),
			`dark matches: ${seen}`,
		);
	}
	await tab.click(`.spModePick[data-page-mode="theme"]`);
	await tab.click('.spThemePick[data-theme="default"]');
	await sleep(300);
	await shot(tab, 'settings');
	await tab.eval(() => document.getElementById('spClose')?.click());

	// ---- extensions ----

	await tab.click('#toolMenu');
	await sleep(300);
	await tab.click('#menuExtensions');
	const extensions = await tab.until(
		() => {
			const page = document.getElementById('shieldsPage');
			return page?.dataset.view === 'extensions' && page.getClientRects().length
				? document.getElementById('shieldsPageTitle')?.textContent
				: null;
		},
		{ timeout: 5000 },
	);
	if (!extensions) {
		// the menu's Extensions is a list when there are any: the page from its row
		await tab.eval(() => openExtensionsPage());
	}
	const opened =
		extensions ??
		(await tab.until(
			() =>
				document.getElementById('shieldsPage')?.dataset.view === 'extensions' &&
				document.getElementById('shieldsPageTitle')?.textContent,
			{ timeout: 5000 },
		));
	ok(
		'extensions: the Extensions page opens',
		opened === 'Extensions',
		short(opened),
	);
	await shot(tab, 'extensions');
	await tab.eval(() => document.getElementById('spClose')?.click());
	await tab.close();
}

// ---- the landing: Tor, offline.html ----

{
	const { tab } = await openDemo(servers.host);
	const tor = await tab.eval(() => ({
		unavailable: document
			.getElementById('torLabel')
			.hasAttribute('data-unavailable'),
		disabled: document.getElementById('tor').disabled,
		title: document.getElementById('torLabel').title,
	}));
	ok(
		'Tor: the box is unavailable with no relay',
		tor.unavailable && tor.disabled,
		short(tor),
	);
	const before = new Set(readdirSync(firefox.downloads));
	await tab.click('#offlineDownload > div');
	let saved = null;
	for (let i = 0; i < 120 && !saved; i++) {
		await sleep(500);
		saved =
			readdirSync(firefox.downloads).find(
				(name) => !before.has(name) && !/\.part$/.test(name),
			) ?? null;
		if (saved && existsSync(`${firefox.downloads}/${saved}.part`)) saved = null;
	}
	const text = saved
		? readFileSync(`${firefox.downloads}/${saved}`, 'utf8')
		: '';
	// (the element the file names its wisp server in, demo/public/pm/main.js OFFLINE_WISP)
	const wisp =
		/<script type="application\/json" id="pm-wisp">([^<]*)<\/script>/.exec(
			text,
		)?.[1];
	ok(
		"offline.html: Download saves the file, with this page's wisp server",
		saved === 'offline.html' &&
			text.length > 1e6 &&
			new RegExp(
				`^"ws://(localhost|127\\.0\\.0\\.1):${servers.port}/wisp/"$`,
			).test(wisp ?? ''),
		`${saved} ${text.length} bytes, wisp ${wisp}`,
	);
	await tab.close();
	if (saved) {
		const offline = await firefox.newTab();
		const from = firefox.logs.length;
		const since = Date.now();
		// every load the file leaves to the browser that names a file: URL
		// (a worker, a shared worker, a fetch): the page answers each of its
		// own from the copies it carries, and anything else on file: is a
		// path of the proxy's that no copy answered (file:///stomp/...),
		// which Firefox refuses with a Security Error and Chrome with a
		// SecurityError. Run before the file's scripts, so its own captures
		// of these globals are these.
		await firefox.send('script.addPreloadScript', {
			contexts: [offline.context],
			functionDeclaration: String(() => {
				const seen = [];
				Object.defineProperty(window, '__pmFileLoads', { value: seen });
				const fileURL = (input) => {
					try {
						const url = new URL(
							input instanceof Request ? input.url : String(input),
							document.baseURI,
						);
						return url.protocol === 'file:' &&
							url.href.split('#')[0] !== location.href.split('#')[0]
							? url.href
							: null;
					} catch {
						return null;
					}
				};
				for (const name of ['Worker', 'SharedWorker']) {
					const Native = window[name];
					if (!Native) continue;
					window[name] = new Proxy(Native, {
						construct(target, args, newTarget) {
							const url = fileURL(args[0]);
							if (url) seen.push(`${name} ${url}`);
							return Reflect.construct(target, args, newTarget);
						},
					});
				}
				const nativeFetch = window.fetch;
				window.fetch = function fetch(input, init) {
					const url = fileURL(input);
					if (url) seen.push(`fetch ${url}`);
					return Reflect.apply(nativeFetch, this, [input, init]);
				};
			}),
		});
		await offline.go(pathToFileURL(`${firefox.downloads}/${saved}`).href);
		const status = await offline.until(
			() => {
				const text = document.getElementById('logMsg')?.textContent ?? '';
				return /^(Ready|Error)/.test(text) ? text : null;
			},
			{ timeout: 90000 },
		);
		ok(
			'offline.html: the saved file boots from file:',
			status === 'Ready',
			status,
		);
		// (what the harness's servers do, not Firefox: a file: page reads the
		// wisp server's /webtransport.json across origins, which a demo server
		// with no WebTransport answers with a 404 that has no CORS header, and
		// the wisp server refuses the hosts of the file's own content
		// blocker's lists, WISP_BLOCK_HOSTS: Chrome says both too)
		const HARNESS_NOISE = [
			/^javascript: Cross-Origin Request Blocked: .*\/webtransport\.json\. .*Status code: 404\.$/,
			/^console: Error: Hyper client: .*tls handshake eof/,
		];
		const offlineErrors = errorsSince(from).filter(
			(text) => !HARNESS_NOISE.some((noise) => noise.test(text)),
		);
		ok(
			'offline.html: no console errors as it boots',
			!offlineErrors.length,
			short(offlineErrors, 2000),
		);
		if (status === 'Ready') {
			await submitLanding(offline, SMOKE);
			const found = await fixtureReport(offline);
			// (what a page reads there in Chrome too: its title, its elements
			// and the server's cookies in a fetch; its synchronous request, localStorage, a
			// WebSocket, a worker and a frame of its own fail in both, as no
			// service worker is there to answer them)
			ok(
				'offline.html: the fixture page loads through it',
				!!found &&
					found.value.title === nativeReport?.title &&
					found.value.elements === nativeReport?.elements &&
					/ffHidden=1/.test(found.value.fetchCookie) &&
					/ffServer=1/.test(found.value.fetchCookie),
				short(found?.value),
			);
			ok(
				"offline.html: the page's document.cookie reads as in Chrome",
				!!found && found.value.cookie === nativeReport?.cookie,
				short(found?.value?.cookie),
			);
		}
		const fileLoads = await offline
			.eval(() => window.__pmFileLoads ?? null)
			.catch((error) => [`unread: ${error.message}`]);
		ok(
			'offline.html: no load of its own goes to the browser on file:',
			Array.isArray(fileLoads) && !fileLoads.length,
			short(fileLoads, 2000),
		);
		const security = (await firefox.platformMessages(since)).filter(
			(message) =>
				/security/i.test(message.category) ||
				/^Security Error|may not load data from/.test(message.text),
		);
		ok(
			'offline.html: no Security Error',
			!security.length,
			short(security, 2000),
		);
		await shot(offline, 'offline');
		await offline.close();
	}
}

// ---- Tor mode, its profile ----
// (a demo server of its own whose Tor relay is the first server's ordinary
// wisp: the client's selection and the profile, not Tor, as demo-tor does)

{
	const tor = await startServers({
		env: { STOMP_TOR_WISP_URL: `ws://127.0.0.1:${servers.port}/wisp/` },
	});
	const { tab, status } = await openDemo(tor.host);
	ok('Tor: a demo with a relay says Ready', status === 'Ready', status);
	await submitLanding(tab, SMOKE);
	const normal = await fixtureReport(tab);
	ok(
		'Tor: in normal mode the fixture page reports',
		!!normal && normal.value.localStorage?.[0] === 'kept',
		short(normal?.value?.localStorage),
	);
	await tab.eval(() => document.getElementById('home').click());
	await sleep(500);
	const box = await tab.eval(() => ({
		disabled: document.getElementById('tor').disabled,
	}));
	ok('Tor: the box is offered with a relay', !box.disabled, short(box));
	await tab.click('#tor');
	await sleep(1500);
	const torStatus = await tab.until(
		() => {
			const text = document.getElementById('logMsg')?.textContent ?? '';
			return /^(Ready|Error)/.test(text)
				? { text, directory: DIRECTORY, requested: TOR_REQUESTED }
				: null;
		},
		{ timeout: 60000 },
	);
	ok(
		'Tor: turned on, the page comes back in Tor mode on its own scope',
		/^Ready/.test(torStatus?.text) &&
			torStatus.requested === true &&
			torStatus.directory === '/stomp-tor/',
		short(torStatus),
	);
	await submitLanding(tab, `${tor.fixture}pages/walk-1.html`);
	const seen = await waitActive(tab, () =>
		document.title === 'WALK 1'
			? { stored: localStorage.getItem('ff-smoke'), cookie: document.cookie }
			: null,
	);
	ok(
		"Tor: a page loads in Tor mode, and the normal mode's site data is not in its profile",
		!!seen && seen.stored === null && !/ffPage/.test(seen.cookie),
		short(seen),
	);
	await tab.eval(() => document.getElementById('home').click());
	await sleep(500);
	await tab.click('#tor');
	await sleep(1500);
	const off = await tab.until(
		() => {
			const text = document.getElementById('logMsg')?.textContent ?? '';
			return /^(Ready|Error)/.test(text)
				? { text, directory: DIRECTORY, requested: TOR_REQUESTED }
				: null;
		},
		{ timeout: 60000 },
	);
	ok(
		'Tor: turned off, the ordinary scope is back',
		off?.requested === false && off.directory === '/stomp/',
		short(off),
	);
	await tab.close();
	tor.stop();
}

// ---- dialing on content slots ----

{
	const from = firefox.logs.length;
	const { tab, status } = await openDemo(
		`${servers.proxy}?mode=just-call-stomp`,
	);
	ok(
		'dialing: the demo in dialing mode says Ready',
		status === 'Ready',
		status,
	);
	await submitLanding(tab, SMOKE);
	const found = await fixtureReport(tab);
	ok('dialing: the fixture page reports', !!found, found?.url);
	if (found) {
		const url = new URL(found.url);
		ok(
			"dialing: the page's frame is a call page on a content slot, naming nothing",
			servers.contentPorts.includes(Number(url.port)) &&
				!/stomp|route|127\.0\.0\.1|%3A|fixture|smoke|walk/i.test(
					url.pathname.replace(/\.html$/, '') + url.search,
				),
			found.url,
		);
		for (const key of [
			'title',
			'cookie',
			'localStorage',
			'syncXhr',
			'webSocket',
			'worker',
			'iframe',
		]) {
			const a = JSON.stringify(nativeReport?.[key]);
			const b = JSON.stringify(found.value[key]);
			ok(
				`dialing: fixture ${key} reads as natively`,
				a === b,
				`native ${a}, proxied ${b}`,
			);
		}
	}
	const dialErrors = errorsSince(from);
	ok('dialing: no console errors', !dialErrors.length, short(dialErrors, 2000));
	await shot(tab, 'dialing');
	await tab.close();
}

console.log(
	`\n${passed + known} passed (${known} known open), ${failed} failed`,
);
await firefox.close();
servers.stop();
process.exit(failed ? 1 : 0);
