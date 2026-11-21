// The demo's own address names no page (demo/public/pm/main.js, "the top
// URL"): each entry it shows is a token, the bare query `?N`, whose page
// only this browser tab's sessionStorage knows. The just-call-stomp audit's
// walk (test/jcs-audit.mjs: a fresh profile with an extension that has the
// webNavigation, tabs and history permissions; A1, a link to A2, a
// pushState, a fragment link, a link to the cross-site B1, the browser's
// Back and Forward), in nav mode (frames navigated) and dial mode
// (?mode=just-call-stomp, documents written into fresh frames), then a
// reload, a second tab, a switch back, a reload with both tabs and the
// address opened in a new tab. Checked in each mode:
//  - the extension's tabs.url and history.search, the tab's back list, the
//    top's Navigation API and its history events only ever show the demo's
//    address with its flags and a token (or none, home);
//  - the profile's History database (visits, visited_links) holds no sealed
//    route and no plain URL of the walk's pages for the top; nav mode's
//    frames still navigate, so its subframe rows are the frames' routes,
//    which are counted and not the top's;
//  - the top's history.length grows by the walk's four entries, as natively;
//  - Back and Forward reach A2 and B1 again, with B1's token back;
//  - a reload shows B1 again at its token, a switch of tabs puts the tab's
//    own token in the address, a reload with two tabs brings both back;
//  - the address in a new tab (no sessionStorage of its own) opens home and
//    loses its token.
import { kind, runMode } from '../jcs-audit.mjs';
import {
	done,
	FIXTURE,
	HOST,
	ok,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const OTHER = `http://127.0.0.1:${new URL(FIXTURE).port}/pages/jcs-a1.html?other`;
let demoOrigin = new URL(PROXY).origin;

/** what an address is as the demo's own: `token`, `home`, else `other` */
function topKind(url, query) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (error) {
		return 'other';
	}
	if (parsed.origin !== demoOrigin || parsed.pathname !== '/' || parsed.hash)
		return 'other';
	const parts = parsed.search.slice(1).split('&').filter(Boolean);
	const flags = parts.filter((part) => !/^\d+=?$/.test(part));
	if (flags.join('&') !== (query ?? '')) return 'other';
	const tokens = parts.length - flags.length;
	return tokens === 1 ? 'token' : tokens === 0 ? 'home' : 'other';
}
const tokenOf = (url) =>
	new URL(url).search
		.slice(1)
		.split('&')
		.filter((part) => /^\d+=?$/.test(part))
		.pop()
		?.replace('=', '') ?? '';

/** the URLs of `list` that are not the demo's address (about:blank and browser pages aside) */
function strays(list, query) {
	return list.filter(
		(url) =>
			url &&
			!['blank', 'browser'].includes(kind(url)) &&
			topKind(url, query) === 'other',
	);
}

/** a frame's document route or link route, which only a navigated frame has */
const frameRoute = (url) =>
	/\/stomp\/[\w-]+\/html\/|\/stomp\/~\//.test(new URL(url).pathname);

async function waitFor(reports, from, pred, timeout = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const found = reports.slice(from).find(pred);
		if (found) return found;
		await sleep(100);
	}
	return null;
}

/** after the walk: reload, a second tab, a switch, a reload with both, a new tab */
async function extra({ page, context, cdp, reports, base, step }) {
	const out = {};
	const frames = () =>
		page.evaluate(() => document.querySelectorAll('#browser .frame').length);
	out.atB1 = page.url();
	await step('reload', async () => {
		const mark = reports.length;
		await page.reload();
		out.reloaded = await waitFor(
			reports,
			mark,
			(r) => r.step === 'b1' && r.why === 'load',
		);
		await sleep(1000);
		out.afterReload = page.url();
		out.framesAfterReload = await frames();
	});
	await step('secondTab', async () => {
		const mark = reports.length;
		await submitLanding(page, OTHER);
		out.other = await waitFor(
			reports,
			mark,
			(r) => r.step === 'a1' && r.why === 'load' && r.href.includes('?other'),
		);
		await sleep(1000);
		out.atOther = page.url();
	});
	await step('switch', async () => {
		await page.click('#recents');
		await sleep(900);
		// a side card centres on the first click and opens on the second
		const open = () =>
			page.evaluate(() => {
				const cards = [...document.querySelectorAll('.cardLabel')];
				cards[0]?.click();
			});
		await open();
		await sleep(700);
		await open();
		await sleep(1500);
		out.switched = page.url();
	});
	await step('reloadTwo', async () => {
		const mark = reports.length;
		await page.reload();
		out.reloadedB1 = await waitFor(
			reports,
			mark,
			(r) => r.step === 'b1' && r.why === 'load',
		);
		out.reloadedOther = await waitFor(
			reports,
			mark,
			(r) => r.step === 'a1' && r.why === 'load' && r.href.includes('?other'),
		);
		await sleep(1000);
		out.afterReloadTwo = page.url();
		out.framesAfterReloadTwo = await frames();
	});
	await step('newTab', async () => {
		const tab = await context.newPage();
		await tab.goto(page.url());
		await tab.waitForFunction(
			() =>
				/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
			null,
			{ timeout: 45000 },
		);
		await sleep(1500);
		out.newTab = await tab.evaluate(() => ({
			href: location.href,
			landing: !document.getElementById('landing').classList.contains('hidden'),
			frames: document.querySelectorAll('#browser .frame').length,
		}));
		// A token no tab owns can also be reached by the browser's Forward
		// button, without loading a new document. It must return to home there.
		await tab.evaluate(() => {
			const query = location.search;
			history.pushState(
				null,
				'',
				`${location.pathname}${query}${query ? '&' : '?'}999999999999`,
			);
		});
		await tab.goBack();
		await tab.goForward();
		await sleep(300);
		out.unknownHistory = await tab.evaluate(() => ({
			href: location.href,
			landing: !document.getElementById('landing').classList.contains('hidden'),
			frames: document.querySelectorAll('#browser .frame').length,
		}));
		await tab.close();
	});
	await step('topNavigation', async () => {
		out.navigation = await page.evaluate(() => ({
			entries: navigation.entries().map((entry) => entry.url),
			current: navigation.currentEntry.url,
			length: history.length,
		}));
		const { entries } = await cdp.send('Page.getNavigationHistory');
		out.backList = entries.map((entry) => entry.url);
	});
	out.base = base;
	return out;
}

for (const [mode, query] of [
	['nav', 'nopool'],
	['isolated', 'nopool'],
	['jcs', 'nopool&mode=just-call-stomp'],
]) {
	demoOrigin = new URL(mode === 'isolated' ? HOST : PROXY).origin;
	console.log(`=== ${mode}`);
	let record;
	try {
		record = await runMode(mode, query, { extra });
	} catch (error) {
		ok(`${mode}: the walk ran`, false, String(error.message).slice(0, 300));
		continue;
	}
	const s = record.steps;
	const snap = record.snapshot ?? {};
	const x = s.extra ?? {};
	ok(
		`${mode}: the walk reached B1 and its frame, with no error`,
		!!s.b1 && !!s.childB1 && !record.errors.length,
		record.errors.join('; ').slice(0, 300),
	);
	const watchers = [snap.watcher, s.watcherEnd, s.watcherAfter].filter(Boolean);
	const events = (k, top = false) =>
		watchers.flatMap((w) =>
			(w.events ?? [])
				.filter((e) => e.kind === k && (!top || e.frameId === 0))
				.map((e) => e.url),
		);
	const lists = {
		'tabs.url': [
			...events('tabs.updated'),
			...watchers.flatMap((w) => (w.tabs ?? []).map((t) => t.url)),
		],
		'history.search': watchers.flatMap((w) =>
			(w.history ?? []).map((h) => h.url),
		),
		// (both navigated modes' frames are navigated: subframe visits are their
		// routes, counted with the History database's frame rows below)
		'history.onVisited': events('history.visited').filter(
			(url) => mode === 'jcs' || !frameRoute(url),
		),
		"the top's webNavigation commits and history updates": [
			...events('nav.committed', true),
			...events('nav.history', true),
			...events('nav.fragment', true),
		],
		'the back list': [
			...(snap.tabHistory?.entries ?? []).map((e) => e.url),
			...(x.backList ?? []),
		],
		"the top's Navigation API": [
			...((snap.frames ?? [])[0]?.entries ?? []),
			...(x.navigation?.entries ?? []),
			x.navigation?.current,
		],
		"the top's address at each step": [
			(snap.frames ?? [])[0]?.href,
			s.back?.topUrl,
			s.forward?.topUrl,
			x.atB1,
			x.afterReload,
			x.atOther,
			x.switched,
			x.afterReloadTwo,
		],
	};
	for (const [name, list] of Object.entries(lists)) {
		const bad = strays(list, query);
		ok(
			`${mode}: ${name} only shows the demo's address and a token`,
			list.some((url) => url && topKind(url, query) === 'token') && !bad.length,
			bad.length
				? bad.slice(0, 3).join(' ')
				: `${list.filter(Boolean).length} URLs`,
		);
	}
	if (mode === 'jcs') {
		// the dialed tab's entries are the page's own: one token each
		const walked = (snap.tabHistory?.entries ?? [])
			.map((e) => e.url)
			.filter((url) => topKind(url, query) === 'token')
			.map(tokenOf);
		ok(
			`${mode}: each entry of the walk has a token of its own`,
			new Set(walked).size === 5 && walked.length === 5,
			walked.join(' '),
		);
	}
	const top = (snap.frames ?? [])[0] ?? {};
	ok(
		`${mode}: the top's history.length grows by the walk's four entries`,
		top.historyLength === record.hostBefore?.historyLength + 4,
		`${record.hostBefore?.historyLength} / ${top.historyLength}`,
	);
	ok(
		`${mode}: browser Back shows A2 again, at a token`,
		/^a2$/.test(s.back?.report?.step ?? '') &&
			topKind(s.back?.topUrl, query) === 'token',
		JSON.stringify({ step: s.back?.report?.step, top: s.back?.topUrl }),
	);
	ok(
		`${mode}: browser Forward shows B1 again, at its token`,
		s.forward?.report?.step === 'b1' &&
			topKind(s.forward?.topUrl, query) === 'token',
		JSON.stringify({ step: s.forward?.report?.step, top: s.forward?.topUrl }),
	);
	ok(
		`${mode}: a reload shows B1 again, at the same token`,
		!!x.reloaded &&
			x.afterReload === x.atB1 &&
			topKind(x.atB1, query) === 'token' &&
			x.framesAfterReload === 1,
		JSON.stringify({
			reloaded: !!x.reloaded,
			at: x.atB1,
			after: x.afterReload,
			frames: x.framesAfterReload,
		}),
	);
	ok(
		`${mode}: a second tab has a token of its own`,
		!!x.other && topKind(x.atOther, query) === 'token' && x.atOther !== x.atB1,
		`${x.atOther} after ${x.atB1}`,
	);
	ok(
		`${mode}: a switch back to the first tab puts its token in the address`,
		x.switched === x.atB1,
		`${x.switched}, the tab's ${x.atB1}`,
	);
	ok(
		`${mode}: a reload with two tabs brings both back, the one on show at its token`,
		!!x.reloadedB1 &&
			!!x.reloadedOther &&
			x.framesAfterReloadTwo === 2 &&
			x.afterReloadTwo === x.atB1,
		JSON.stringify({
			b1: !!x.reloadedB1,
			other: !!x.reloadedOther,
			frames: x.framesAfterReloadTwo,
			at: x.afterReloadTwo,
		}),
	);
	ok(
		`${mode}: the address in a new tab opens home and loses its token`,
		!!x.newTab?.landing &&
			x.newTab.frames === 0 &&
			topKind(x.newTab.href, query) === 'home',
		JSON.stringify(x.newTab),
	);
	ok(
		`${mode}: an unknown token reached by browser Forward returns home`,
		!!x.unknownHistory?.landing &&
			x.unknownHistory.frames === 0 &&
			topKind(x.unknownHistory.href, query) === 'home',
		JSON.stringify(x.unknownHistory),
	);
	// the profile on disk
	const disk = record.disk ?? {};
	if (!Array.isArray(disk.visits) || !Array.isArray(disk.visitedLinks)) {
		ok(
			`${mode}: the History database could be read`,
			false,
			JSON.stringify(disk.visits ?? disk.visitedLinks).slice(0, 200),
		);
		continue;
	}
	// a subframe visit (core transition 3 or 4) is a frame's own navigation
	const frameVisit = (v) => v.core === 3 || v.core === 4;
	const topVisits = disk.visits.filter((v) => !frameVisit(v));
	const leaked = (url) => ['plain', 'route'].includes(kind(url));
	ok(
		`${mode}: the History database's top visits are the demo's address and a token`,
		topVisits.some((v) => topKind(v.url, query) === 'token') &&
			!topVisits.some((v) => leaked(v.url) || strays([v.url], query).length),
		topVisits
			.map((v) => v.url)
			.filter((url) => strays([url], query).length)
			.slice(0, 3)
			.join(' ') || `${topVisits.length} visits`,
	);
	const frameRows = [
		...disk.visits.filter(frameVisit).map((v) => v.url),
		...disk.visitedLinks.map((l) => l.link),
	];
	const topRows = disk.visitedLinks.map((l) => l.top_level_url);
	ok(
		`${mode}: visited_links names the top by the demo's address and a token`,
		!strays(topRows, query).length,
		strays(topRows, query).slice(0, 3).join(' '),
	);
	if (mode !== 'jcs')
		console.log(
			`  nav's frames navigate: ${frameRows.filter(leaked).length} History rows of theirs (subframe visits, visited links) name their routes, ${frameRows.filter((url) => kind(url) === 'plain').length} a plain URL`,
		);
	else
		ok(
			`${mode}: the History database holds no route and no plain URL at all`,
			!disk.visits.some((v) => leaked(v.url)) &&
				!disk.visitedLinks.some(
					(l) =>
						leaked(l.link) || leaked(l.top_level_url) || leaked(l.frame_url),
				),
			frameRows.filter(leaked).slice(0, 3).join(' ') ||
				`${disk.visits.length} visits, ${disk.visitedLinks.length} links`,
		);
	ok(
		`${mode}: no plain URL of the walk in the History database`,
		![...disk.visits.map((v) => v.url), ...frameRows].some(
			(url) => kind(url) === 'plain',
		),
	);
}
await done(null);
