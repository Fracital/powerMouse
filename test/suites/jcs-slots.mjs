// Dialing's content slots (docs/content-slots.md, docs/site-pool.md "Just
// call stomp on the slots"): the demo server answers on four ports of its
// own for the mode (STOMP_SLOT_PORTS, as production's four behind
// Cloudflare), and a controller with those as its pool writes each site's
// documents into the call page of the site's slot, its own origin. Checked
// against Chrome's own behaviour for the same two sites (the fixture on
// 127.0.0.1 and on localhost):
// - the demo page hands those ports to its controller in just call stomp
//   mode only, and its default mode keeps one origin;
// - a slot's service worker is registered only when a site is first shown
//   from it: none before, two of the four for two sites;
// - a pool whose slot does not answer writes the site on the host's own
//   origin (the fallback), as a controller without a pool does;
// - a page and a frame of another site in it are two processes (the
//   page's 300 ms busy loop does not hold up the frame's timers, and a
//   message takes a process hop), as natively; a frame of the page's own
//   site is in the page's slot and process; without the slots (one origin)
//   they all share the host's;
// - every frame's real src and location are a call page, of the slot of
//   its site;
// - the browser's storage of one slot is not another's, and a frame of the
//   page's site sees the page's;
// - a page on one slot cannot script or read another slot's document, its
//   storage or its worker, in the page's world or below it;
// - a link to another site moves the tab to that site's slot, with the
//   Referer and fetch metadata Chrome sends, and Back returns to the
//   first site's slot; the host hears each document's report.
import { createServer } from 'node:net';
import {
	done,
	evaluateIsolated,
	FIXTURE,
	launch,
	ok,
	PROXY,
	REWRITER,
	sleep,
} from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/site-pool.html';
// the call page of the suite's own controllers (the asset `callPage`'s
// default; the demo page's dialing mode mints its own scope and name)
const CALL = 'k3v9.html';
const run = Date.now().toString(36);
const TIMING = process.env.SKIP_TIMING !== '1';
const JCS = (process.env.CONTENT_SLOT_PORTS ?? '')
	.split(',')
	.map(Number)
	.filter((port) => port > 0);

const browser = await launch();
const context = await browser.newContext();
const errors = [];

/** a port nothing listens on (taken from the system, then let go) */
async function closedPort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** `code` run in `frame` as the page's own code runs: rewritten (the frame's Function) */
const asPage = (frame, code) =>
	frame.evaluate((code) => Function(code)(), code);

/** the frame of an element handle, once it shows a document whose URL passes `test` */
async function frameOf(element, test = () => true, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await element.contentFrame().catch(() => null);
		if (frame && test(frame.url())) {
			try {
				await frame.waitForLoadState('load', { timeout: 5000 });
			} catch (error) {
				// loaded by the time its URL shows
			}
			return frame;
		}
		if (Date.now() > until) return frame;
		await sleep(100);
	}
}

/** the page's own location.href once the document is written into `frame`'s call page (it is the call page's until then) */
async function hrefOnce(frame, test, ms = 15000) {
	const until = Date.now() + ms;
	for (;;) {
		const href = await asPage(frame, 'return location.href').catch(() => '');
		if (test(href) || Date.now() > until) return href;
		await sleep(100);
	}
}

/** the kit's probe (the parent spins 300 ms while its #child measures its timers) and a message round trip */
async function observe(parent) {
	const gap = await asPage(parent, 'return __sp.probe()');
	const rtt = await asPage(parent, 'return __sp.rtt(200)');
	return { gap, rtt };
}

// --- natively: a page of A with a frame of B, then of A ---
const native = await context.newPage();
await native.goto(
	`${A}${PAGE}?native&child=${encodeURIComponent(`${B}${PAGE}?nc`)}`,
);
const nativeCross = await observe(native.mainFrame());
await native.goto(
	`${A}${PAGE}?native&child=${encodeURIComponent(`${A}${PAGE}?ns`)}`,
);
await sleep(300);
const nativeSame = await observe(native.mainFrame());
await native.close();
ok(
	'natively, the frame of another site runs while its page spins',
	nativeCross.gap < 200,
	`${nativeCross.gap} ms`,
);
ok(
	'natively, the frame of the same site waits for it',
	nativeSame.gap >= 280,
	`${nativeSame.gap} ms`,
);

// --- the demo page: the ports in just call stomp mode only ---
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
// every service worker registration of the profile, by origin
const registered = new Set();
const cdp = await context.newCDPSession(page);
cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
	for (const registration of registrations)
		if (!registration.isDeleted)
			registered.add(new URL(registration.scopeURL).origin);
});
await cdp.send('ServiceWorker.enable');
await page.goto(`${PROXY}`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
ok(
	'the demo server hands the just call stomp ports to the page',
	await page.evaluate(
		(ports) =>
			JSON.stringify(window.STOMP_CONFIG.contentSlots) ===
			JSON.stringify(ports),
		JCS,
	),
	JSON.stringify(JCS),
);
ok(
	'the demo page in its default mode keeps one origin',
	(await page.evaluate(() => window.controller.siteMode)) === false,
);
await page.goto(`${PROXY}?mode=just-call-stomp`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const SLOTS = JCS.map((port) => `http://127.0.0.1:${port}`);
ok(
	'the demo page in just call stomp mode shows the sites from those ports',
	await page.evaluate(
		(slots) =>
			window.controller.siteMode &&
			JSON.stringify(window.controller.siteOrigins) === JSON.stringify(slots),
		SLOTS,
	),
	JSON.stringify(await page.evaluate(() => window.controller.siteOrigins)),
);
// (the hub starts no spare: WARM_WAIT_MS and an idle moment past it)
await sleep(3500);
ok(
	'in just call stomp mode no slot has a service worker before a site is shown from it',
	SLOTS.every((slot) => !registered.has(slot)),
	JSON.stringify([...registered]),
);
ok(
	'every slot answers with Origin-Agent-Cluster: ?1',
	(
		await Promise.all(
			SLOTS.map(async (slot) =>
				(await fetch(`${slot}/stomp/controller.mjs`)).headers.get(
					'origin-agent-cluster',
				),
			),
		)
	).every((value) => value === '?1'),
);

// the suite's own controllers beside the demo's: one on the slots, one on
// the host's origin alone
await page.goto(`${PROXY}?nopool`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(
	async ({ rewriter, SLOTS }) => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		const make = (extra) =>
			new StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				dialing: true,
				...rewriter,
				...extra,
			});
		window.make = make;
		// (as the demo page in that mode: no spare slot)
		window.slotted = make({ sitePool: { origins: SLOTS, warm: false } });
		window.single = make({});
		await Promise.all([window.slotted.wait(), window.single.wait()]);
		window.tabs = [];
		window.call = async (controller, url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 400px; height: 220px';
			document.body.append(element);
			const frame = window[controller].createFrame(element);
			const reports = [];
			frame.addEventListener('navigate', (event) =>
				reports.push(event.detail?.url ?? null),
			);
			frame.reports = reports;
			window.tabs.push(frame);
			await StompController.justCallStomp(frame, url);
			return window.tabs.length - 1;
		};
	},
	{ rewriter: REWRITER, SLOTS },
);
const startHistory = await page.evaluate(() => history.length);

/** a called tab: its frame (index among window.tabs), its element and the Playwright frame of its document */
async function call(controller, url, test = () => true) {
	const tab = await page.evaluate(
		({ controller, url }) => window.call(controller, url),
		{ controller, url },
	);
	return { tab, ...(await shown(tab, test)) };
}
async function shown(tab, test = () => true) {
	const element = (
		await page.evaluateHandle((tab) => window.tabs[tab].element, tab)
	).asElement();
	return { element, frame: await frameOf(element, test) };
}
const originOf = (url) => {
	try {
		return new URL(url).origin;
	} catch (error) {
		return null;
	}
};
const callPage = (url, depth = '') =>
	SLOTS.includes(originOf(url)) &&
	new URL(url).pathname === `/stomp/${CALL}` &&
	new URL(url).search === depth;
/** the parent's #child once it shows the document `real` (the page's URL) on a call page that passes `test` */
async function childOf(parent, test, real, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		// (the call page is there before the document is written into it)
		const element = await parent.$('#child').catch(() => null);
		const frame = await element?.contentFrame().catch(() => null);
		if (frame && test(frame.url())) {
			const href = await asPage(frame, 'return location.href').catch(() => '');
			if (href === real) return frame;
		}
		if (Date.now() > until) return frame;
		await sleep(150);
	}
}

// a page of A with a frame of B, on the slots
const cross = await call(
	'slotted',
	`${A}${PAGE}?a&child=${encodeURIComponent(`${B}${PAGE}?ab`)}`,
	(url) => callPage(url),
);
const slotA = originOf(cross.frame.url());
ok(
	"the tab's document is written in a call page of a slot",
	callPage(cross.frame.url()),
	cross.frame.url(),
);
ok(
	'its src is that call page',
	callPage(await cross.element.getAttribute('src')),
	await cross.element.getAttribute('src'),
);
ok(
	'the page reads its real URL',
	(
		await hrefOnce(cross.frame, (href) => href.startsWith(`${A}${PAGE}?a&`))
	).startsWith(`${A}${PAGE}?a&`),
);
const crossChild = await childOf(
	cross.frame,
	(url) => callPage(url, '?1') && originOf(url) !== slotA,
	`${B}${PAGE}?ab`,
);
const slotB = originOf(crossChild?.url());
const slotsWithWorkers = () =>
	SLOTS.filter((slot) => registered.has(slot)).sort();
ok(
	"a slot's service worker is registered when a site is first shown from it, and only then",
	JSON.stringify(slotsWithWorkers()) === JSON.stringify([slotA, slotB].sort()),
	`${JSON.stringify(slotsWithWorkers())} of ${SLOTS.length}`,
);
ok(
	'the frame of another site is written in a call page of another slot',
	callPage(crossChild?.url() ?? '', '?1') && slotB !== slotA,
	`${slotA} ${crossChild?.url()}`,
);
ok(
	'the frame reads its real URL',
	(await asPage(crossChild, 'return location.href')) === `${B}${PAGE}?ab`,
);
const slotted = await observe(cross.frame);
ok(
	"the page's busy loop does not hold up the frame of another site, as natively",
	slotted.gap < 200,
	`${slotted.gap} ms (natively ${nativeCross.gap} ms)`,
);
ok(
	'each side of a message sees the other site as its origin, as natively',
	slotted.rtt.child === nativeCross.rtt.child &&
		slotted.rtt.parent === nativeCross.rtt.parent,
	JSON.stringify(slotted.rtt),
);

// a page of A with a frame of A: one slot, one process
const same = await call(
	'slotted',
	`${A}${PAGE}?s&child=${encodeURIComponent(`${A}${PAGE}?ss`)}`,
	(url) => callPage(url),
);
const sameChild = await childOf(
	same.frame,
	(url) => callPage(url, '?1'),
	`${A}${PAGE}?ss`,
);
ok(
	'a site keeps its slot in another tab',
	originOf(same.frame.url()) === slotA,
	same.frame.url(),
);
ok(
	"a frame of the page's site is written in the page's slot",
	originOf(sameChild?.url()) === slotA,
	sameChild?.url(),
);
const sameSlot = await observe(same.frame);
ok(
	"the frame of the page's site waits for its busy loop, as natively",
	sameSlot.gap >= 280,
	`${sameSlot.gap} ms (natively ${nativeSame.gap} ms)`,
);

// without the slots: the host's origin for every site
const single = await call(
	'single',
	`${A}${PAGE}?o&child=${encodeURIComponent(`${B}${PAGE}?ob`)}`,
	(url) => url.startsWith(`${PROXY}stomp/${CALL}`),
);
await childOf(
	single.frame,
	(url) => url.startsWith(`${PROXY}stomp/${CALL}?1`),
	`${B}${PAGE}?ob`,
);
const one = await observe(single.frame);
ok(
	'without the slots the two sites share the host process (as before)',
	one.gap >= 280,
	`${one.gap} ms`,
);

// a pool whose one slot does not answer (a network that lets the host's
// port through alone): the host's origin, as without a pool
const unanswered = `http://127.0.0.1:${await closedPort()}`;
await page.evaluate(async (origin) => {
	window.unanswered = window.make({ sitePool: { origins: [origin] } });
	await window.unanswered.wait();
}, unanswered);
const fallback = await call(
	'unanswered',
	`${A}${PAGE}?f&child=${encodeURIComponent(`${B}${PAGE}?fb`)}`,
	(url) => url.startsWith(`${PROXY}stomp/${CALL}`),
);
ok(
	"with its slot unanswered, a site is written in the host origin's call page",
	(fallback.frame?.url() ?? '').startsWith(`${PROXY}stomp/${CALL}`) &&
		(
			await hrefOnce(fallback.frame, (href) =>
				href.startsWith(`${A}${PAGE}?f&`),
			)
		).startsWith(`${A}${PAGE}?f&`),
	fallback.frame?.url(),
);
const fallbackChild = await childOf(
	fallback.frame,
	(url) => url.startsWith(`${PROXY}stomp/${CALL}?1`),
	`${B}${PAGE}?fb`,
);
ok(
	'and so is its frame of another site',
	(fallbackChild?.url() ?? '').startsWith(`${PROXY}stomp/${CALL}?1`) &&
		(await asPage(fallbackChild, 'return location.href')) === `${B}${PAGE}?fb`,
	fallbackChild?.url(),
);

if (TIMING) {
	console.log(
		`timers held up by the parent's 300 ms: natively ${nativeCross.gap}, slots ${slotted.gap}, one origin ${one.gap}; same site natively ${nativeSame.gap}, slots ${sameSlot.gap}`,
	);
	console.log(
		`message round trip, median ms: natively ${nativeCross.rtt.median.toFixed(2)}, slots ${slotted.rtt.median.toFixed(2)}, one origin ${one.rtt.median.toFixed(2)}`,
	);
}

// --- storage: the browser's own stores are each slot's ---
const key = `jcs-${run}`;
await evaluateIsolated(
	cross.frame,
	(key) => {
		localStorage.setItem(key, location.origin);
		return true;
	},
	key,
);
const seen = async (frame) =>
	evaluateIsolated(frame, (key) => localStorage.getItem(key), key);
ok(
	"another slot's frame has none of the first slot's storage",
	(await seen(crossChild)) === null,
	String(await seen(crossChild)),
);
ok(
	"a frame of the page's slot has the page's storage",
	(await seen(sameChild)) === slotA,
	String(await seen(sameChild)),
);
ok(
	"the host's origin has none of it",
	(await page.evaluate((key) => localStorage.getItem(key), key)) === null,
);
// what the pages store (the proxy's view): a site's own
await asPage(cross.frame, `localStorage.setItem('${key}', 'a')`);
await sleep(300);
ok(
	"the page's storage is not the other site's",
	(await asPage(crossChild, `return localStorage.getItem('${key}')`)) === null,
);
ok(
	'and is the same site in another tab',
	(await asPage(same.frame, `return localStorage.getItem('${key}')`)) === 'a',
);

// --- a page on one slot cannot reach another slot's document ---
const reach = await asPage(
	cross.frame,
	`const out = {};
	const frame = document.getElementById('child').contentWindow;
	for (const [name, read] of Object.entries({
		document: () => frame.document,
		href: () => frame.location.href,
		storage: () => frame.localStorage,
	}))
		try { read(); out[name] = 'read'; } catch (error) { out[name] = error.name; }
	return out;`,
);
ok(
	"the page cannot read the other site's document, location or storage",
	Object.values(reach).every((value) => value === 'SecurityError'),
	JSON.stringify(reach),
);
const raw = await evaluateIsolated(
	cross.frame,
	async ({ slotB, CALL }) => {
		const out = {};
		const frame = document.getElementById('child').contentWindow;
		for (const [name, read] of Object.entries({
			document: () => frame.document,
			href: () => frame.location.href,
			storage: () => frame.localStorage,
			parent: () => parent.document,
			top: () => top.location.href,
		}))
			try {
				read();
				out[name] = 'read';
			} catch (error) {
				out[name] = error.name;
			}
		try {
			await fetch(`${slotB}/stomp/${CALL}`);
			out.fetch = 'read';
		} catch (error) {
			out.fetch = error.name;
		}
		const registration = await navigator.serviceWorker.getRegistration();
		out.worker = registration ? new URL(registration.scope).origin : null;
		return out;
	},
	{ slotB, CALL },
);
ok(
	"below the page's hooks too, a slot reaches no other slot's document, the host's or another slot's network",
	raw.document === 'SecurityError' &&
		raw.href === 'SecurityError' &&
		raw.storage === 'SecurityError' &&
		raw.parent === 'SecurityError' &&
		raw.top === 'SecurityError' &&
		raw.fetch === 'TypeError',
	JSON.stringify(raw),
);
ok("each slot's documents are its own worker's", raw.worker === slotA);
const rawSame = await evaluateIsolated(same.frame, () => {
	try {
		return document.getElementById('child').contentWindow.location.href;
	} catch (error) {
		return error.name;
	}
});
ok(
	"a page reaches its own site's frame on its slot (as natively)",
	callPage(rawSame, '?1'),
	rawSame,
);

// --- the host's own frames and input while a busy page runs in a tab ---
/** the host page's animation frames and key input over `ms`, with `url` in a tab of `controller` */
async function hostWhileBusy(controller, url, ms = 4000) {
	const busy = await call(controller, url, (u) => u.includes(`/stomp/${CALL}`));
	await sleep(800);
	await page.evaluate(() => {
		let input = document.getElementById('jcs-input');
		if (!input) {
			input = document.createElement('input');
			input.id = 'jcs-input';
			input.style.cssText = 'position: fixed; left: 0; top: 0; z-index: 99999';
			document.body.append(input);
			input.addEventListener('keydown', (event) =>
				window.jcsDelays.push(performance.now() - event.timeStamp),
			);
		}
		window.jcsDelays = [];
		window.jcsFrames = [];
		input.focus();
		let last = performance.now();
		window.jcsRunning = true;
		const tick = (now) => {
			window.jcsFrames.push(now - last);
			last = now;
			if (window.jcsRunning) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	const until = Date.now() + ms;
	while (Date.now() < until) {
		await page.keyboard.press('a');
		await sleep(100);
	}
	const measured = await page.evaluate(() => {
		window.jcsRunning = false;
		const p95 = (list) =>
			Math.round(
				[...list].sort((a, b) => a - b)[Math.floor(list.length * 0.95)] ?? 0,
			);
		return {
			input: p95(window.jcsDelays),
			frame: p95(window.jcsFrames.slice(1)),
			long: window.jcsFrames.filter((gap) => gap > 100).length,
		};
	});
	await page.evaluate((tab) => window.tabs[tab].element.remove(), busy.tab);
	return measured;
}
if (TIMING) {
	const onSlot = await hostWhileBusy('slotted', `${A}pages/jcs-busy.html`);
	const onHost = await hostWhileBusy('single', `${A}pages/jcs-busy.html`);
	console.log(
		`the host while a page spins 200 ms of every 250 in a tab, p95 ms: key input ${onSlot.input} from a slot, ${onHost.input} in one origin; animation frame ${onSlot.frame} / ${onHost.frame}; frames over 100 ms ${onSlot.long} / ${onHost.long}`,
	);
	ok(
		"a busy page in a slot leaves the host's input and frames alone",
		onSlot.input < 100 && onSlot.frame < 100,
		JSON.stringify(onSlot),
	);
	ok(
		'in one origin it holds them up (as before)',
		onHost.input >= 100 || onHost.frame >= 100,
		JSON.stringify(onHost),
	);
}

// --- a link to another site: the tab moves to that site's slot ---
const linkKey = `${run}-link`;
const hostHistory = await page.evaluate(() => history.length);
const linker = await call(
	'slotted',
	`${A}${PAGE}?l&to=${encodeURIComponent(`${B}echo-headers?k=${linkKey}`)}`,
	(url) => callPage(url),
);
const linkTab = linker.tab;
ok('the link page is on its slot', originOf(linker.frame.url()) === slotA);
const beforeLink = await page.evaluate(() => history.length);
await linker.frame.click('#to');
const landed = await page.waitForFunction(
	(tab) => {
		const frame = window.tabs[tab];
		return frame.called?.entries.length === 2 && frame.element.src;
	},
	linkTab,
	{ timeout: 30000 },
);
const landedSrc = await landed.jsonValue();
ok(
	"the next document is written in its own site's slot",
	callPage(landedSrc) && originOf(landedSrc) === slotB,
	landedSrc,
);
const headers = await (async () => {
	for (let i = 0; i < 80; i++) {
		const recorded = await (
			await fetch(`${FIXTURE}echo-headers/recorded?k=${linkKey}`)
		).json();
		if (recorded) return recorded;
		await sleep(250);
	}
	return null;
})();
ok(
	'the site gets the Referer and fetch metadata of a cross-site link, as natively',
	headers?.referer === A &&
		headers?.['sec-fetch-site'] === 'cross-site' &&
		headers?.['sec-fetch-mode'] === 'navigate',
	JSON.stringify(
		headers && {
			referer: headers.referer,
			site: headers['sec-fetch-site'],
			mode: headers['sec-fetch-mode'],
			dest: headers['sec-fetch-dest'],
		},
	),
);
await page.evaluate((tab) => window.tabs[tab].back(), linkTab);
const back = await page.waitForFunction(
	(tab) => {
		const frame = window.tabs[tab];
		return frame.called?.index === 0 && frame.element.src;
	},
	linkTab,
	{ timeout: 30000 },
);
const backSrc = await back.jsonValue();
ok(
	"Back writes the first page in its site's slot again",
	callPage(backSrc) && originOf(backSrc) === slotA,
	backSrc,
);
const backFrame = (await shown(linkTab, (url) => originOf(url) === slotA))
	.frame;
ok(
	'it reads its own URL again',
	(await asPage(backFrame, 'return location.href')).startsWith(`${A}${PAGE}?l`),
);
await sleep(500);
const reports = await page.evaluate((tab) => window.tabs[tab].reports, linkTab);
const other = await call('slotted', `${B}${PAGE}?r`, (url) => callPage(url));
await sleep(500);
const otherReports = await page.evaluate(
	(tab) => window.tabs[tab].reports,
	other.tab,
);
ok(
	"the host hears each slot's documents report",
	originOf(other.frame.url()) === slotB &&
		reports.filter((url) => url?.startsWith(`${A}${PAGE}?l`)).length >= 2 &&
		otherReports.some((url) => url === `${B}${PAGE}?r`),
	JSON.stringify({ reports, otherReports }),
);
ok(
	'no slot no site was shown from ever had a service worker',
	JSON.stringify(slotsWithWorkers()) === JSON.stringify([slotA, slotB].sort()),
	`${JSON.stringify(slotsWithWorkers())} of ${SLOTS.length}`,
);
const after = await page.evaluate(() => history.length);
ok(
	"the host's own history did not grow across the slots",
	after === startHistory,
	`${startHistory} at the start, ${hostHistory} before the link's tab, ${beforeLink} before the link, ${after} after Back and another tab`,
);

// --- a slot whose agent goes (its renderer crashed, or the host removed it)
// while a document of it is shown: the next call that would be made from
// that slot finds its agent silent, the hub leaves the slot out, and the
// document is written on the host's own origin ---
const homing = await call(
	'slotted',
	`${A}${PAGE}?h&to=${encodeURIComponent(`${A}${PAGE}?h2`)}`,
	(url) => callPage(url) && originOf(url) === slotA,
);
await hrefOnce(homing.frame, (href) => href.startsWith(`${A}${PAGE}?h&`));
const errorsBeforeGone = errors.length;
await page.evaluate(
	({ slot, CALL }) => {
		for (const element of document.querySelectorAll('iframe'))
			if (element.src.startsWith(slot) && !element.src.includes(`/${CALL}`))
				element.src = 'about:blank';
	},
	{ slot: slotA, CALL },
);
await sleep(500);
await homing.frame.click('#to');
const homed = await page.waitForFunction(
	({ tab, slot }) => {
		const frame = window.tabs[tab];
		return (
			frame.called?.entries.length === 2 &&
			frame.called.index === 1 &&
			!frame.element.src.startsWith(slot) &&
			frame.element.src
		);
	},
	{ tab: homing.tab, slot: slotA },
	{ timeout: 30000 },
);
const homedSrc = await homed.jsonValue();
const homedFrame = (await shown(homing.tab, (url) => url === homedSrc)).frame;
ok(
	"a link in a document of a slot whose agent went is written in the host origin's call page",
	homedSrc.startsWith(`${PROXY}stomp/${CALL}`) &&
		(await hrefOnce(homedFrame, (href) => href === `${A}${PAGE}?h2`)) ===
			`${A}${PAGE}?h2`,
	homedSrc,
);
ok(
	'and the hub leaves that slot out',
	await page.evaluate((slot) => window.slotted.siteOriginLeftOut(slot), slotA),
);
ok(
	'no error reaches the pages once the agent went',
	errors.length === errorsBeforeGone,
	JSON.stringify(errors.slice(errorsBeforeGone)),
);

await done(browser, errors);
