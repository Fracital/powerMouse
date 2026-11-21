// The walk of the just-call-stomp audit (suites/just-call-stomp-audit.mjs,
// which says what it measures) and its table, for the suites that read the
// same observers: runMode walks one mode in a fresh profile with the
// watcher extension and returns everything each observer held.
import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import {
	activeFrame,
	CHROME,
	evaluateIsolated,
	FIXTURE,
	HOST,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from './lib.mjs';

const RESOLVER =
	'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1';
export const F = new URL(FIXTURE).port;
export const A1 = `http://127.0.0.1:${F}/pages/jcs-a1.html`;
export const MARK = 'visit7Q';
export const OUT = process.env.JCS_AUDIT_OUT || '';

// the demo's dialing mode serves its scope under a neutral name the server
// minted (demo/server.js STOMP_DIAL_DIRECTORY): its routes are routes too
const DIAL_SCOPES = await (async () => {
	try {
		await waitForServer(PROXY);
		const text = await (await fetch(`${PROXY}config.js`)).text();
		const { dial } = JSON.parse(
			/window\.STOMP_CONFIG = (.*);\s*$/s.exec(text)[1],
		);
		return [dial.directory, dial.torDirectory].filter(Boolean);
	} catch (error) {
		return [];
	}
})();
const SCOPES = ['/stomp/', ...DIAL_SCOPES];

export function jcsQuery() {
	if (process.env.JCS_QUERY !== undefined)
		return process.env.JCS_QUERY.replace(/^\?/, '') || null;
	return 'mode=just-call-stomp';
}

/** what a URL says of the walk: the page in the clear, a sealed route, the host, a blank */
export function kind(url) {
	if (url === null || url === undefined || url === '') return 'none';
	const text = String(url);
	if (/^about:/.test(text)) return 'blank';
	if (/^chrome|^devtools/.test(text)) return 'browser';
	if (text.includes('jcs-shape-host')) return 'host';
	if (text.includes(MARK) || text.includes(`:${F}/`)) return 'plain';
	// a document's route (/stomp/<id>/<kind>/<sealed>), a link route
	// (/stomp/~/<sealed>), or the demo's fragment that names one (#html/...)
	// (or the dialing mode's scope's)
	if (
		SCOPES.some(
			(scope) =>
				new RegExp(`${scope}[\\w-]+/[\\w:~-]+/[\\w-]{6,}`).test(text) ||
				new RegExp(`${scope}~/[\\w-]{6,}`).test(text),
		) ||
		/#html\/[\w-]{6,}/.test(text)
	)
		return 'route';
	// the proxy's own scripts and assets
	if (SCOPES.some((scope) => text.includes(scope))) return 'asset';
	try {
		const { host } = new URL(text);
		if (host === new URL(PROXY).host || host === new URL(HOST).host)
			return 'host';
	} catch (error) {
		return 'other';
	}
	return 'other';
}
/** `{ plain: 3, route: 2 }` for a list of URLs (distinct ones counted once) */
export function kinds(urls) {
	const counts = {};
	for (const url of new Set(urls.filter((u) => u !== null && u !== undefined)))
		counts[kind(url)] = (counts[kind(url)] ?? 0) + 1;
	return counts;
}
export const short = (counts) =>
	Object.entries(counts)
		.map(([k, n]) => `${k} ${n}`)
		.join(', ') || 'nothing';

// the school filter's extension: it keeps every event it sees
const WATCHER = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'jcs watcher',
		version: '1',
		permissions: ['webNavigation', 'webRequest', 'tabs', 'history'],
		host_permissions: ['<all_urls>'],
		background: { service_worker: 'bg.js' },
	}),
	'bg.js': `
self.events = [];
const keep = (kind) => (d) => self.events.push({ kind, url: d.url, frameId: d.frameId, type: d.type, transition: d.transitionType, tabId: d.tabId });
chrome.webNavigation.onBeforeNavigate.addListener(keep('nav.before'));
chrome.webNavigation.onCommitted.addListener(keep('nav.committed'));
chrome.webNavigation.onHistoryStateUpdated.addListener(keep('nav.history'));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(keep('nav.fragment'));
chrome.webRequest.onBeforeRequest.addListener(keep('req.frame'), { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] });
chrome.webRequest.onSendHeaders.addListener((d) => self.events.push({ kind: 'req.headers', url: d.url, type: d.type, tabId: d.tabId, referer: d.requestHeaders?.find((h) => /^referer$/i.test(h.name))?.value ?? null }), { urls: ['<all_urls>'] }, ['requestHeaders']);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.url || info.title) self.events.push({ kind: 'tabs.updated', url: info.url ?? null, title: info.title ?? null, tabId }); });
chrome.history.onVisited.addListener((item) => self.events.push({ kind: 'history.visited', url: item.url, title: item.title }));
self.snapshot = async () => {
	const tabs = await chrome.tabs.query({});
	const frames = [];
	for (const tab of tabs)
		for (const f of (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [])
			frames.push({ tabId: tab.id, frameId: f.frameId, url: f.url });
	const history = await chrome.history.search({ text: '', startTime: 0, maxResults: 1000 });
	return {
		tabs: tabs.map((t) => ({ url: t.url, title: t.title })),
		frames,
		history: history.map((h) => ({ url: h.url, title: h.title, visits: h.visitCount })),
	};
};
`,
};

async function launchProfile() {
	const dir = mkdtempSync(join(tmpdir(), 'stomp-jcs-audit-'));
	const profile = join(dir, 'profile');
	const netlog = join(dir, 'netlog.json');
	const ext = join(dir, 'watcher');
	mkdirSync(ext);
	for (const [name, text] of Object.entries(WATCHER))
		writeFileSync(join(ext, name), text);
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: CHROME,
		headless: false, // --headless=new below: the old headless runs no extension
		viewport: { width: 1280, height: 800 },
		args: [
			'--headless=new',
			'--no-sandbox',
			'--no-first-run',
			'--enable-unsafe-extension-debugging',
			`--host-resolver-rules=${RESOLVER}`,
			`--log-net-log=${netlog}`,
			'--net-log-capture-mode=Default',
		],
		ignoreDefaultArgs: [
			'--disable-extensions',
			'--enable-automation',
			'--disable-component-extensions-with-background-pages',
			'--headless',
			'--hide-scrollbars',
			'--disable-back-forward-cache',
		],
	});
	let watcher = null;
	try {
		const session = await context.browser()?.newBrowserCDPSession();
		if (session) {
			// (Chrome's component extensions have workers of their own)
			const { id } = await session.send('Extensions.loadUnpacked', {
				path: ext,
			});
			for (let i = 0; i < 40 && !watcher; i++) {
				watcher = context
					.serviceWorkers()
					.find((w) => w.url() === `chrome-extension://${id}/bg.js`);
				if (!watcher) await sleep(250);
			}
		}
	} catch (error) {
		console.log(`(no watcher extension: ${error.message})`);
	}
	return { dir, profile, netlog, context, watcher };
}

function reportsOf(context) {
	const reports = [];
	context.on('console', (message) => {
		const text = message.text();
		if (!text.startsWith('JCS:')) return;
		try {
			reports.push(JSON.parse(text.slice(4)));
		} catch (error) {
			// a line cut short
		}
	});
	return reports;
}

async function waitReport(reports, from, pred, timeout = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const found = reports.slice(from).find(pred);
		if (found) return found;
		await sleep(100);
	}
	return null;
}

/** what a content script reads in `frame`: real attributes and state */
const frameView = () => {
	const nav = performance.getEntriesByType('navigation')[0];
	return {
		href: location.href,
		url: document.URL,
		name: window.name,
		historyLength: history.length,
		srcs: [...document.querySelectorAll('iframe')].map((element) =>
			element.getAttribute('src'),
		),
		navName: nav?.name ?? null,
		navType: nav?.type ?? null,
		entries: window.navigation
			? navigation.entries().map((entry) => entry.url)
			: null,
		resources: performance
			.getEntriesByType('resource')
			.filter(
				(entry) =>
					entry.initiatorType === 'iframe' || entry.name.includes('/stomp/'),
			)
			.map((entry) => entry.name),
	};
};

/** every frame below the top a content script of the top reaches, depth first */
const treeView = () => {
	const out = [];
	const walk = (doc, depth) => {
		for (const element of doc.querySelectorAll('iframe')) {
			const entry = { depth, src: element.getAttribute('src') };
			out.push(entry);
			try {
				const win = element.contentWindow;
				entry.href = win.location.href;
				entry.url = win.document.URL;
				entry.name = win.name;
				entry.navName =
					win.performance.getEntriesByType('navigation')[0]?.name ?? null;
				entry.historyLength = win.history.length;
				walk(win.document, depth + 1);
			} catch (error) {
				entry.crossOrigin = true;
			}
		}
	};
	walk(document, 1);
	return out;
};

function grepFile(path, needles) {
	let buffer;
	try {
		buffer = readFileSync(path);
	} catch (error) {
		return [];
	}
	const found = [];
	for (const needle of needles)
		if (
			buffer.includes(Buffer.from(needle, 'utf8')) ||
			buffer.includes(Buffer.from(needle, 'utf16le'))
		)
			found.push(needle);
	return found;
}

function walkFiles(root) {
	const out = [];
	const stack = [root];
	while (stack.length) {
		const at = stack.pop();
		let names;
		try {
			names = readdirSync(at);
		} catch (error) {
			continue;
		}
		for (const name of names) {
			const path = join(at, name);
			let stat;
			try {
				stat = statSync(path);
			} catch (error) {
				continue;
			}
			if (stat.isDirectory()) stack.push(path);
			else if (stat.size < 64 * 1024 * 1024 && !name.endsWith('.copy'))
				out.push(path);
		}
	}
	return out;
}

// Node's own SQLite (node:sqlite, Node 22.13 and later without a flag; CI
// runs 24), so the runner needs no sqlite3 binary; an older Node falls back
// to the binary where there is one
const nodeSqlite = await import('node:sqlite').catch(() => null);

/** the rows of `query` on a copy of the database at `path`, or `{ error }` */
function sqlite(path, query) {
	const copy = `${path}.copy`;
	try {
		writeFileSync(copy, readFileSync(path));
		if (nodeSqlite) {
			const db = new nodeSqlite.DatabaseSync(copy, { readOnly: true });
			try {
				return db
					.prepare(query)
					.all()
					.map((row) => ({ ...row }));
			} finally {
				db.close();
			}
		}
		const text = execFileSync('sqlite3', ['-json', copy, query], {
			encoding: 'utf8',
		});
		return text.trim() ? JSON.parse(text) : [];
	} catch (error) {
		return {
			error: `${nodeSqlite ? 'node:sqlite' : 'no node:sqlite, sqlite3'}: ${String(error.message).slice(0, 200)}`,
		};
	} finally {
		rmSync(copy, { force: true });
	}
}

function readNetlog(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		return { error: 'no net log' };
	}
	let log;
	try {
		log = JSON.parse(text);
	} catch (error) {
		// a log the browser did not finish: close its event list
		try {
			log = JSON.parse(`${text.replace(/,\s*$/, '')}]}`);
		} catch (again) {
			return { error: 'unreadable net log' };
		}
	}
	const types = log.constants?.logEventTypes ?? {};
	const sources = log.constants?.logSourceType ?? {};
	const START = types.URL_REQUEST_START_JOB;
	const HEADERS = types.HTTP_TRANSACTION_SEND_REQUEST_HEADERS;
	const urlBySource = new Map();
	const urls = [];
	const referers = [];
	for (const event of log.events ?? []) {
		if (event.type === START && event.params?.url) {
			urls.push(event.params.url);
			urlBySource.set(event.source?.id, event.params.url);
		}
	}
	for (const event of log.events ?? [])
		if (event.type === HEADERS && Array.isArray(event.params?.headers)) {
			const referer = event.params.headers
				.find((line) => /^referer:/i.test(line))
				?.slice(8)
				.trim();
			const line = event.params.line ?? '';
			referers.push({
				url: urlBySource.get(event.source?.id) ?? line,
				referer: referer ?? null,
			});
		}
	return { urls, referers, sourceTypes: Object.keys(sources).length };
}

/**
 * Walk `mode` (a page query for the demo's modes); `extra` runs after the
 * walk's Back and Forward with the open browser (`{ page, context, cdp,
 * reports, base, step }`), before the watcher's last look and the profile
 * read
 */
export async function runMode(mode, query, { extra = null } = {}) {
	const proxied = mode !== 'native' && mode !== 'shape';
	const base = /isolated/.test(mode) ? HOST : PROXY;
	const { dir, profile, netlog, context, watcher } = await launchProfile();
	const reports = reportsOf(context);
	const navRequests = [];
	context.on('request', (request) => {
		if (request.isNavigationRequest())
			navRequests.push({
				url: request.url(),
				referer: request.headers().referer ?? null,
				frame: (() => {
					try {
						return request.frame().url();
					} catch (error) {
						return null;
					}
				})(),
			});
	});
	const record = { mode, query, steps: {}, errors: [] };
	const step = async (name, fn) => {
		try {
			record.steps[name] = await fn();
		} catch (error) {
			record.errors.push(`${name}: ${String(error.message).slice(0, 300)}`);
		}
	};
	const page = await context.newPage();
	page.on('pageerror', (error) =>
		record.errors.push(`pageerror: ${error.message.slice(0, 200)}`),
	);
	if (/sealed/.test(mode))
		// the demo's page with the sealed route in its fragment, as it was
		// before its tokens (pm/main.js ADDRESS_FRAGMENT, which an embedder
		// gets)
		await page.addInitScript(() => {
			if (window !== window.top) return;
			let config;
			Object.defineProperty(window, 'STOMP_CONFIG', {
				configurable: true,
				get: () => config,
				set: (value) => {
					config = { ...value, addressFragment: 'sealed' };
				},
			});
		});
	let frameOf;
	if (proxied) {
		await waitForServer(base);
		await page.goto(query ? `${base}?${query}` : base);
		await page.waitForFunction(
			() =>
				/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
			null,
			{ timeout: 45000 },
		);
		record.hostBefore = await page.evaluate(() => ({
			historyLength: history.length,
			href: location.href,
		}));
		await submitLanding(page, A1);
		frameOf = () => activeFrame(page);
	} else if (mode === 'shape') {
		const host = `http://localhost:${F}/pages/jcs-shape-host.html`;
		await page.goto(host);
		record.hostBefore = await page.evaluate(() => ({
			historyLength: history.length,
			href: location.href,
		}));
		await page.evaluate((url) => window.__shapeGo(url), A1);
		frameOf = async () => (await page.$('iframe.frame'))?.contentFrame();
	} else {
		record.hostBefore = { historyLength: 1, href: 'about:blank' };
		await page.goto(A1);
		frameOf = async () => page.mainFrame();
	}
	const click = async (selector) => {
		const frame = await frameOf();
		if (!frame) throw new Error('no frame to click in');
		await frame.click(selector, { timeout: 20000 });
	};
	const at = () => reports.length;
	let mark = at();
	record.steps.a1 = await waitReport(
		reports,
		0,
		(r) => r.step === 'a1' && r.why === 'load',
	);
	record.steps.childA1 = await waitReport(
		reports,
		0,
		(r) => r.step === 'child' && r.why === 'load' && r.href.includes('?a1'),
		10000,
	);
	await sleep(500);
	mark = at();
	await step('clickNext', () => click('#next'));
	record.steps.a2 = await waitReport(
		reports,
		mark,
		(r) => r.step === 'a2' && r.why === 'load',
	);
	await sleep(500);
	mark = at();
	await step('clickPush', () => click('#push'));
	record.steps.push = await waitReport(
		reports,
		mark,
		(r) => r.step === 'a2' && r.why === 'push',
	);
	mark = at();
	await step('clickHash', () => click('#hash'));
	record.steps.hash = await waitReport(
		reports,
		mark,
		(r) => r.step === 'a2' && r.why === 'hashchange',
		10000,
	);
	await sleep(500);
	mark = at();
	await step('clickCross', () => click('#cross'));
	record.steps.b1 = await waitReport(
		reports,
		mark,
		(r) => r.step === 'b1' && r.why === 'load',
	);
	record.steps.childB1 = await waitReport(
		reports,
		mark,
		(r) => r.step === 'child' && r.why === 'load' && r.href.includes('?b1'),
		10000,
	);
	// the history thread and the session service trail a navigation
	await sleep(2500);

	// ---- what every observer holds once B1 is shown
	const snap = {};
	record.snapshot = snap;
	const cdp = await context.newCDPSession(page);
	await step('tabHistory', async () => {
		const { currentIndex, entries } = await cdp.send(
			'Page.getNavigationHistory',
		);
		snap.tabHistory = {
			currentIndex,
			entries: entries.map((e) => ({ url: e.url, title: e.title })),
		};
	});
	await step('frames', async () => {
		snap.frames = [];
		for (const frame of page.frames()) {
			const view = await evaluateIsolated(frame, frameView).catch((error) => ({
				error: String(error.message).slice(0, 120),
			}));
			snap.frames.push({ devtoolsUrl: frame.url(), ...view });
		}
	});
	// the same from the top's content script, through every frame of its
	// origin: a written frame's CDP frame tree names its creator's URL where
	// Playwright says about:blank, so evaluateIsolated cannot find it
	await step('tree', async () => {
		snap.tree = await evaluateIsolated(page.mainFrame(), treeView);
	});
	await step('serviceWorkerClients', async () => {
		snap.serviceWorkerClients = [];
		for (const worker of context.serviceWorkers()) {
			if (worker.url().startsWith('chrome-extension://')) continue;
			const clients = await worker
				.evaluate(async () =>
					(
						await clients.matchAll({ includeUncontrolled: true, type: 'all' })
					).map((c) => ({ type: c.type, url: c.url, frameType: c.frameType })),
				)
				.catch((error) => [{ error: String(error.message).slice(0, 120) }]);
			snap.serviceWorkerClients.push({ worker: worker.url(), clients });
		}
	});
	if (proxied)
		await step('embedderDecodes', async () => {
			const route = (snap.frames ?? [])
				.map((f) => f.href)
				.find((u) => kind(u) === 'route' && u.includes('/stomp/'));
			snap.embedderDecodes = route
				? {
						route,
						real: await page.evaluate(
							(u) => window.controller?.unroute?.(u) ?? null,
							route,
						),
					}
				: null;
		});
	await step('watcherMid', async () => {
		if (!watcher) return null;
		snap.watcher = await watcher.evaluate(async () => ({
			events: self.events,
			...(await self.snapshot()),
		}));
	});

	// what a crash at this moment would leave for the next start to restore:
	// the session files as they are on disk while the browser runs
	await step('crashCopy', () =>
		cpSync(join(profile, 'Default', 'Sessions'), join(dir, 'crash-sessions'), {
			recursive: true,
		}),
	);

	// ---- the browser's own Back and Forward
	await step('back', async () => {
		const { currentIndex, entries } = await cdp.send(
			'Page.getNavigationHistory',
		);
		if (currentIndex < 1) return { skipped: 'no entry before' };
		mark = at();
		await cdp.send('Page.navigateToHistoryEntry', {
			entryId: entries[currentIndex - 1].id,
		});
		const report = await waitReport(
			reports,
			mark,
			(r) => r.step === 'a2' || r.step === 'a1',
			15000,
		);
		await sleep(1000);
		return {
			report,
			reports: reports.slice(mark).map((r) => `${r.step}:${r.why}`),
			topUrl: page.url(),
		};
	});
	await step('forward', async () => {
		const { currentIndex, entries } = await cdp.send(
			'Page.getNavigationHistory',
		);
		if (currentIndex >= entries.length - 1)
			return { skipped: 'no entry after' };
		mark = at();
		await cdp.send('Page.navigateToHistoryEntry', {
			entryId: entries[currentIndex + 1].id,
		});
		const report = await waitReport(
			reports,
			mark,
			(r) => r.step === 'b1',
			15000,
		);
		await sleep(1000);
		return {
			report,
			reports: reports.slice(mark).map((r) => `${r.step}:${r.why}`),
			topUrl: page.url(),
		};
	});
	await step('topAfter', () =>
		evaluateIsolated(page.mainFrame(), () => ({
			href: location.href,
			historyLength: history.length,
		})),
	);
	await step('watcherEnd', async () => {
		if (!watcher) return null;
		return watcher.evaluate(async () => ({
			events: self.events,
			...(await self.snapshot()),
		}));
	});
	if (extra) {
		await step('extra', () =>
			extra({ page, context, cdp, reports, base, step }),
		);
		await step('watcherAfter', async () => {
			if (!watcher) return null;
			return watcher.evaluate(async () => ({
				events: self.events,
				...(await self.snapshot()),
			}));
		});
	}
	record.navRequests = navRequests;
	record.reports = reports;

	// ---- the profile, once the browser closed
	await Promise.race([context.close().catch(() => {}), sleep(20000)]);
	const def = join(profile, 'Default');
	record.disk = {
		visits: sqlite(
			join(def, 'History'),
			'select u.url, u.title, u.hidden, (v.transition & 255) as core from visits v join urls u on u.id = v.url order by v.id',
		),
		urls: sqlite(
			join(def, 'History'),
			'select url, title, hidden, visit_count from urls order by id',
		),
		visitedLinks: sqlite(
			join(def, 'History'),
			'select u.url as link, l.top_level_url, l.frame_url from visited_links l join urls u on u.id = l.link_url_id',
		),
	};
	const route = (snap.frames ?? [])
		.map((f) => f.href)
		.filter((u) => kind(u) === 'route' && u.includes('/stomp/'))
		.map((u) => u.split('/').pop().split('#')[0])
		.shift();
	const needles = [MARK, `jcs-b1`, '/stomp/', ...(route ? [route] : [])];
	const sessions = join(def, 'Sessions');
	record.disk.sessions = existsSync(sessions)
		? readdirSync(sessions).map((name) => ({
				file: name,
				found: grepFile(join(sessions, name), needles),
			}))
		: [];
	const crash = join(dir, 'crash-sessions');
	record.disk.crashSessions = existsSync(crash)
		? readdirSync(crash).map((name) => ({
				file: name,
				found: grepFile(join(crash, name), needles),
			}))
		: [];
	const profileHits = {};
	for (const file of walkFiles(profile)) {
		const found = grepFile(file, [MARK, ...(route ? [route] : [])]);
		if (!found.length) continue;
		const area = relative(profile, file).split('/').slice(0, 3).join('/');
		profileHits[area] = [...new Set([...(profileHits[area] ?? []), ...found])];
	}
	record.disk.profileHits = profileHits;
	record.disk.routeNeedle = route ?? null;
	record.netlog = readNetlog(netlog);
	if (OUT) {
		mkdirSync(OUT, { recursive: true });
		writeFileSync(
			join(OUT, `${mode}.json`),
			JSON.stringify(record, null, '\t'),
		);
	}
	rmSync(dir, { recursive: true, force: true });
	return record;
}

// ---- the table
/** a found needle as the table says it: B1's sealed route by that name */
const label = (needle) => (needle.length > 20 ? 'B1 route' : needle);
export function rows(record) {
	const s = record.steps;
	const snap = record.snapshot ?? {};
	const w = snap.watcher ?? {};
	const events = (k) =>
		(w.events ?? []).filter((e) => e.kind === k).map((e) => e.url);
	const top = (snap.frames ?? [])[0] ?? {};
	const perFrame = (snap.frames ?? []).slice(record.mode === 'native' ? 0 : 1);
	// a frame evaluateIsolated could not find: the top's walk instead
	const inner = perFrame.some((f) => f.error)
		? (snap.tree ?? []).filter((f) => !f.crossOrigin)
		: perFrame;
	const b1 = s.b1 ?? {};
	const disk = record.disk ?? {};
	const nl = record.netlog ?? {};
	const proxyHost = new URL(PROXY).host;
	const r = {};
	r['top history.length (before / after walk)'] =
		`${record.hostBefore?.historyLength} / ${top.historyLength}`;
	r['top URL (address bar, bookmarks)'] = kind(top.href);
	r['page history.length at B1'] = b1.historyLength;
	r['top navigation.entries()'] = top.entries
		? `${top.entries.length}: ${short(kinds(top.entries))}`
		: 'n/a';
	r['page navigation.entries() at B1'] = b1.entries
		? `${b1.entries.length}: ${short(kinds(b1.entries))}`
		: 'n/a';
	r['tab back list (DevTools, back menu)'] = snap.tabHistory
		? `${snap.tabHistory.entries.length}: ${short(kinds(snap.tabHistory.entries.map((e) => e.url)))}; titles ${[...new Set(snap.tabHistory.entries.map((e) => e.title))].join(' | ').slice(0, 80)}`
		: 'n/a';
	const back = s.back ?? {};
	r['browser Back from B1'] = back.skipped
		? back.skipped
		: `${(back.reports ?? []).join(' ') || 'no report'}; top ${kind(back.topUrl)}`;
	r['bfcache (pageshow persisted on Back)'] = (back.reports ?? []).includes(
		'a2:pageshow-persisted',
	)
		? 'restored'
		: back.report
			? `not restored (${back.report.why}, type ${back.report.navEntry?.type})`
			: 'no report';
	r['iframe src attributes (content script)'] = short(
		kinds(
			[
				...(snap.frames ?? []).flatMap((f) => f.srcs ?? []),
				...(snap.tree ?? []).map((f) => f.src),
			].map((u) => (u === null ? '' : u)),
		),
	);
	r['frames real location (content script)'] = short(
		kinds(inner.map((f) => f.href)),
	);
	r['frames in DevTools frame tree'] = short(
		kinds(perFrame.map((f) => f.devtoolsUrl)),
	);
	r['frames real window.name (content script)'] = inner
		.map((f) => f.name || "''")
		.join(' ')
		.slice(0, 80);
	r['frames real performance navigation entry'] = short(
		kinds(inner.map((f) => f.navName)),
	);
	r['top resource timing (iframe or route entries)'] = short(
		kinds(top.resources ?? []),
	);
	r['page navigation entry at B1 (name, type)'] = b1.navEntry
		? `${kind(b1.navEntry.name)}, ${b1.navEntry.type}`
		: 'n/a';
	r['page document.referrer A2 / B1'] =
		`${s.a2?.referrer ?? 'n/a'} / ${b1.referrer ?? 'n/a'}`;
	r['page window.name at A2 / B1 start'] =
		`${s.a2?.nameAtStart || "''"} / ${b1.nameAtStart || "''"}`;
	r['SW clients (URLs)'] = (snap.serviceWorkerClients ?? []).length
		? short(
				kinds(
					snap.serviceWorkerClients.flatMap((w) => w.clients.map((c) => c.url)),
				),
			)
		: 'no worker';
	r['embedder decodes the route'] = snap.embedderDecodes
		? kind(snap.embedderDecodes.real)
		: 'n/a';
	r['History DB visits (hidden)'] = Array.isArray(disk.visits)
		? `${short(kinds(disk.visits.map((v) => v.url)))}; hidden ${disk.visits.filter((v) => v.hidden).length}; subframe ${disk.visits.filter((v) => v.core === 3 || v.core === 4).length}`
		: JSON.stringify(disk.visits);
	r['History DB visited_links'] = Array.isArray(disk.visitedLinks)
		? short(kinds(disk.visitedLinks.map((v) => v.link)))
		: JSON.stringify(disk.visitedLinks).slice(0, 80);
	r['ext history.search'] = short(kinds((w.history ?? []).map((h) => h.url)));
	r['ext webNavigation committed'] = short(kinds(events('nav.committed')));
	r['ext webNavigation history/fragment'] = short(
		kinds([...events('nav.history'), ...events('nav.fragment')]),
	);
	r['ext webRequest main_frame/sub_frame'] = short(kinds(events('req.frame')));
	r['ext webRequest all (route URLs)'] = `${
		(w.events ?? []).filter(
			(e) => e.kind === 'req.headers' && kind(e.url) === 'route',
		).length
	} requests, ${
		(w.events ?? []).filter(
			(e) => e.kind === 'req.headers' && kind(e.referer) === 'route',
		).length
	} with a route Referer`;
	r['ext tabs URL'] = short(
		kinds([
			...events('tabs.updated').filter(Boolean),
			...(w.tabs ?? []).map((t) => t.url),
		]),
	);
	r['ext webNavigation.getAllFrames'] = short(
		kinds((w.frames ?? []).map((f) => f.url)),
	);
	r['DevTools navigation requests'] = short(
		kinds((record.navRequests ?? []).map((n) => n.url)),
	);
	r['net log URL requests'] = nl.error ?? short(kinds(nl.urls ?? []));
	const toProxy = (nl.referers ?? []).filter((x) => {
		try {
			return new URL(x.url).host === proxyHost;
		} catch (error) {
			return false;
		}
	});
	r['net log Referer to proxy origin'] = nl.error
		? nl.error
		: `${toProxy.length} requests: referer ${short(kinds(toProxy.map((x) => x.referer)))}`;
	r['Sessions files (tab restore)'] =
		(disk.sessions ?? [])
			.map(
				(x) =>
					`${x.file.split('_')[0]}[${x.found.map(label).join(',') || '-'}]`,
			)
			.join(' ') || 'none';
	r['Sessions files mid-walk (crash restore)'] =
		(disk.crashSessions ?? [])
			.map(
				(x) =>
					`${x.file.split('_')[0]}[${x.found.map(label).join(',') || '-'}]`,
			)
			.join(' ') || 'none';
	r['profile files holding B1 (marker or route)'] =
		Object.keys(disk.profileHits ?? {}).join(', ') || 'none';
	r['page isTop / frameElement / ancestorOrigins at B1'] =
		`${b1.isTop} / ${b1.frameElement} / ${(b1.ancestorOrigins ?? []).length}`;
	r['page load order at B1'] = b1.order ?? 'n/a';
	r['page userActivation / focus at B1'] =
		`${JSON.stringify(b1.userActivation)} / ${b1.focus}`;
	r['errors'] = record.errors.length;
	return r;
}
