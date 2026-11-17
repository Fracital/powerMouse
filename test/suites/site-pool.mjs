// The site pool (ControllerInit.sitePool, docs/site-pool.md): every proxied
// site is shown from one of a few origins, other ports of the proxy's own
// host here (the demo server answers on them with STOMP_SITE_POOL), so the
// browser gives each a renderer process of its own. Checked against
// Chrome's own behaviour for the same two sites, the fixture on 127.0.0.1
// and on localhost:
// - a page and the frame of another site in it are two processes: an
//   out-of-process frame to the browser, the page's busy loop does not hold
//   up the frame's timers, their JS heaps differ and a message takes a
//   process hop; the single-origin controller beside it shares one process,
//   as before, and so do the sites of a pool with one slot;
// - a frame that navigates to another site moves to that site's slot, and
//   back into its parent's process when it returns to its parent's site;
// - storage of one site is not another's, a second frame of the same site
//   sees the first's, and a site keeps its slot from one controller to the
//   next;
// - the cookie jar is one for every slot: another site's request carries a
//   site's cookies as natively, and the site reads them from another slot
//   too;
// - a link and a form POST from one site to the other reach the site with
//   the Referer, Origin and fetch metadata Chrome sends (the body of the
//   POST too), the new document's location and referrer are the real ones,
//   and history.back() and the hub's Back and Forward cross the slots;
// - a page whose Content-Security-Policy restricts frames (frame-src,
//   child-src, default-src) or forms (form-action) has the frames of
//   another site it allows, which the pool shows from another slot, as
//   natively, and a frame or a redirect it refuses is refused with Chrome's
//   violation, which names no slot.
import { caseURL, OTHER, report, shape } from '../csp-lib.mjs';
import { done, FIXTURE, launch, ok, PROXY, REWRITER, sleep } from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/site-pool.html';
const run = Date.now().toString(36);
const TIMING = process.env.SKIP_TIMING !== '1';
// the adblock suites' list, for the blocker checks (the run's list blocks nothing this suite loads)
const ADBLOCK = {
	lists: [`${FIXTURE}pages/adblock-list.txt`],
	resources: `${FIXTURE}pages/adblock-resources.json`,
};

const browser = await launch(['--enable-precise-memory-info']);
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const cdp = await context.newCDPSession(page);

/** the iframe targets (out-of-process frames) the browser has, by URL */
async function oopifs(session = cdp) {
	const { targetInfos } = await session.send('Target.getTargets');
	return targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url);
}

/** `code` run in `frame` as the page's own code runs: rewritten (the frame's Function) */
const asPage = (frame, code) =>
	frame.evaluate((code) => Function(code)(), code);

/** recorded request headers of the fixture's /echo-headers under `key` */
async function recorded(key) {
	for (let i = 0; i < 80; i++) {
		const headers = await (
			await fetch(`${FIXTURE}echo-headers/recorded?k=${key}`)
		).json();
		if (headers) return headers;
		await sleep(250);
	}
	return null;
}

/** the frame of an element handle, once it shows a document whose URL passes `test` */
async function frameOf(element, test = () => true, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await element.contentFrame();
		if (frame && test(frame.url())) {
			try {
				await frame.waitForLoadState('load', { timeout: 5000 });
			} catch (error) {
				// a JSON document has loaded by the time its URL shows
			}
			return frame;
		}
		if (Date.now() > until) return frame;
		await sleep(100);
	}
}

/**
 * Click `selector` in `frame`, and once more when the frame's document saw
 * no mousedown. The suite's page grows with every frame it shows, so a
 * frame's button is often below the fold: Playwright scrolls it in and
 * clicks at once, and under load the browser's hit testing has not yet
 * taken the out-of-process frame's new place, so the click goes to the
 * frame element of the document above it (measured, sp-focus 2026-11-15:
 * the top's document got the mousedown on its #child element, the frame's
 * document nothing; the form aimed at the top failed 2 runs in 40).
 */
async function click(frame, selector) {
	for (let attempt = 0; attempt < 2; attempt++) {
		await frame.evaluate(() => {
			window.__spPressed = false;
			addEventListener('mousedown', () => (window.__spPressed = true), {
				capture: true,
				once: true,
			});
		});
		await frame.click(selector);
		for (let i = 0; i < 10; i++) {
			const pressed = await frame
				.evaluate(() => window.__spPressed !== false)
				.catch(() => true); // the document went: it navigated
			if (pressed) return;
			await sleep(100);
		}
		console.log(`a click on ${selector} missed its frame (try ${attempt + 1})`);
	}
}

/** the frame inside `parent`'s #child, once its URL passes `test` */
async function childOf(parent, test = () => true, ms = 45000) {
	return frameOf(await parent.$('#child'), test, ms);
}

/** the kit's probe and the rest of what two documents in one or two processes show, parent and its #child */
async function observe(parent, child) {
	const gap = await asPage(parent, 'return __sp.probe()');
	const rtt = await asPage(parent, 'return __sp.rtt(200)');
	const heaps = [
		await parent.evaluate(() => window.__sp.heap()),
		await child.evaluate(() => window.__sp.heap()),
	];
	return { gap, rtt, heaps };
}

// --- natively: a page of A with a frame of B, then of A ---
const native = await context.newPage();
const nativeCdp = await context.newCDPSession(native);
await native.goto(
	`${A}${PAGE}?native&child=${encodeURIComponent(`${B}${PAGE}?nc`)}`,
);
const nativeChild = await childOf(native, (u) => u.startsWith(B));
const nativeCross = await observe(native.mainFrame(), nativeChild);
ok(
	'natively, the other site is an out-of-process frame',
	(await oopifs(nativeCdp)).some((url) => url.startsWith(B)),
);
ok(
	'natively, the page busy loop does not hold up the frame of another site',
	nativeCross.gap < 200,
	`${nativeCross.gap} ms`,
);
ok(
	'natively, the two sites have heaps of their own',
	nativeCross.heaps[0] !== nativeCross.heaps[1],
	JSON.stringify(nativeCross.heaps),
);
ok(
	'natively, each side of a message sees the other site as its origin',
	nativeCross.rtt.child === new URL(A).origin &&
		nativeCross.rtt.parent === new URL(B).origin,
	JSON.stringify(nativeCross.rtt),
);
// the frame goes to the page's own site: back in its process
await nativeChild.evaluate((to) => (location.href = to), `${A}${PAGE}?nc-same`);
const nativeSameChild = await childOf(native, (u) => u.includes('nc-same'));
const nativeSame = await observe(native.mainFrame(), nativeSameChild);
ok(
	'natively, a frame of the page own site shares its process',
	nativeSame.gap >= 280,
	`${nativeSame.gap} ms`,
);
// natively: B's cookies on a request A's page makes to B
await native.goto(`${B}${PAGE}?native-cookies`);
await native.evaluate(() => {
	document.cookie = 'sp_none=1; path=/; SameSite=None; Secure';
	document.cookie = 'sp_lax=1; path=/';
});
await native.goto(`${A}${PAGE}?native-fetch`);
await native.evaluate(
	(url) => fetch(url, { mode: 'no-cors', credentials: 'include' }),
	`${B}echo-headers?k=${run}-nc`,
);
const nativeCookie = (await recorded(`${run}-nc`))?.cookie ?? '';

// natively: a link and a form POST from A to B
await native.goto(
	`${A}${PAGE}?to=${encodeURIComponent(`${B}echo-headers?k=${run}-nl`)}`,
);
await Promise.all([native.waitForURL(`${B}**`), native.click('#to')]);
const nativeLink = await recorded(`${run}-nl`);
await native.goto(
	`${A}${PAGE}?to=${encodeURIComponent(`${B}echo-headers?k=${run}-np`)}`,
);
await Promise.all([
	native.waitForURL(`${B}**`),
	native.evaluate(() => document.getElementById('post').submit()),
]);
const nativePost = await recorded(`${run}-np`);

// natively: a frame of B under a page of A aims a link, a form and
// window.open at the top (`?target=_top`), clicked (the browser lets a frame
// of another site navigate the top on the user's click); the destination,
// of B, is the tab's next document
const TOP_WAYS = { link: '#to', form: '#send', 'window.open': '#open' };
const topChild = (key) =>
	`${B}${PAGE}?target=_top&to=${encodeURIComponent(`${B}echo-headers?k=${key}`)}`;
const nativeTop = {};
for (const [way, button] of Object.entries(TOP_WAYS)) {
	const key = `${run}-nt-${way}`;
	await native.goto(
		`${A}${PAGE}?nt&child=${encodeURIComponent(topChild(key))}`,
	);
	const frame = await childOf(native, (u) => u.startsWith(B));
	await Promise.all([
		native.waitForURL(`${B}echo-headers**`),
		click(frame, button),
	]);
	nativeTop[way] = await recorded(key);
}
await native.close();
await context.clearCookies();

// --- proxied ---
// the demo's own controller without the pool: the suite makes its own
await page.goto(`${PROXY}?nopool`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const ports = await page.evaluate(() => window.STOMP_CONFIG.sitePool);
ok(
	'the demo server answers on the ports of STOMP_SITE_POOL',
	Array.isArray(ports) && ports.length >= 4,
	JSON.stringify(ports),
);
const SLOTS = ports.map((port) => `http://127.0.0.1:${port}`);
const POOL = SLOTS.slice(0, 3);
const slotOf = (url) => {
	try {
		return new URL(url).origin;
	} catch (error) {
		return null;
	}
};
const inPool = (pool) => (url) =>
	pool.includes(slotOf(url)) && url.includes('/stomp/');
await page.evaluate(
	async ({ rewriter, POOL, SLOTS }) => {
		// the demo's landing overlay would take the clicks
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		window.make = (extra) =>
			new StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				...rewriter,
				...extra,
			});
		window.pool = window.make({ sitePool: { origins: POOL } });
		window.single = window.make({});
		// a pool of one slot: every site shares it
		window.one = window.make({ sitePool: { origins: [SLOTS[3]] } });
		await Promise.all([
			window.pool.wait(),
			window.single.wait(),
			window.one.wait(),
		]);
		window.show = async (controller, url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 400px; height: 200px';
			document.body.append(element);
			const frame = controller.createFrame(element);
			await frame.go(url);
			return element;
		};
	},
	{ rewriter: REWRITER, POOL, SLOTS },
);
ok(
	'the pool controller says it shows sites from a pool, the other not',
	await page.evaluate(() => window.pool.siteMode && !window.single.siteMode),
);

const show = async (controller, url, test) => {
	const element = (
		await page.evaluateHandle(
			({ controller, url }) => window.show(window[controller], url),
			{ controller, url },
		)
	).asElement();
	return { element, frame: await frameOf(element, test) };
};

// a page of A with a frame of B
const a = await show(
	'pool',
	`${A}${PAGE}?a&child=${encodeURIComponent(`${B}${PAGE}?ab`)}`,
	inPool(POOL),
);
const ab = await childOf(a.frame, inPool(POOL));
const slotA = slotOf(a.frame.url());
const slotB = slotOf(ab.url());
ok('a site is shown from a slot of the pool', POOL.includes(slotA), slotA);
ok(
	'the frame of another site in it from another slot',
	POOL.includes(slotB) && slotB !== slotA,
	`${slotA} ${slotB}`,
);
ok(
	'each proxied page knows its real URL',
	(await asPage(a.frame, 'return location.origin')) === new URL(A).origin &&
		(await asPage(ab, 'return location.href')) === `${B}${PAGE}?ab`,
);
ok(
	'the hub frame reports the real URL',
	(await page.evaluate(() => window.pool.frames[0].url)).startsWith(
		`${A}${PAGE}?a&`,
	),
	await page.evaluate(() => window.pool.frames[0].url),
);
const targets = await oopifs();
ok(
	'the page and the frame of another site are out-of-process frames, as natively',
	targets.some((url) => url.startsWith(slotA)) &&
		targets.some((url) => url.startsWith(slotB)),
	JSON.stringify(targets),
);
const cross = await observe(a.frame, ab);
ok(
	'the page busy loop does not hold up the frame of another site, as natively',
	cross.gap < 200,
	`${cross.gap} ms (natively ${nativeCross.gap} ms)`,
);
ok(
	'the two sites have heaps of their own, as natively',
	cross.heaps[0] !== cross.heaps[1],
	JSON.stringify(cross.heaps),
);
ok(
	'each side of a message sees the other site as its origin, as natively',
	cross.rtt.child === nativeCross.rtt.child &&
		cross.rtt.parent === nativeCross.rtt.parent,
	JSON.stringify(cross.rtt),
);
const hostGap = await (async () => {
	const watched = ab.evaluate(() => window.__sp.watch(900));
	await sleep(200);
	await page.evaluate(() => {
		const start = performance.now();
		while (performance.now() - start < 300);
	});
	return watched;
})();
ok(
	'a busy loop in the host page does not hold up a site',
	hostGap < 200,
	`${hostGap} ms`,
);

// the frame goes to the page's own site: into the page's slot and process
await asPage(ab, `location.href = ${JSON.stringify(`${A}${PAGE}?aa`)}`);
const aa = await childOf(
	a.frame,
	(url) => slotOf(url) === slotA && url.includes('/stomp/'),
);
ok(
	'a frame that goes to its parent site moves to the parent slot',
	slotOf(aa.url()) === slotA &&
		(await asPage(aa, 'return location.href')) === `${A}${PAGE}?aa`,
	aa.url(),
);
const same = await observe(a.frame, aa);
ok(
	'and shares its process, as natively',
	same.gap >= 280,
	`${same.gap} ms (natively ${nativeSame.gap} ms)`,
);
// and to the other site again: out of it
await asPage(aa, `location.href = ${JSON.stringify(`${B}${PAGE}?ab2`)}`);
const ab2 = await childOf(a.frame, (url) => slotOf(url) === slotB);
const again = await observe(a.frame, ab2);
ok(
	'a frame that goes to another site moves to that site slot and process',
	slotOf(ab2.url()) === slotB && again.gap < 200,
	`${ab2.url()} ${again.gap} ms`,
);

// a frame of another slot than its page's has no proxied top in reach: it
// rewrites in the library its slot's agent made for every such frame of the
// slot (src/controller/slotLibrary.ts), as a frame rewrites in its top's,
// not in a realm and an instance of its own; and its eval is rewritten
// there, answering what it answers natively
const clientName = await page.evaluate(() => window.pool.config.names.client);
const agentOfB = page
	.frames()
	.find(
		(frame) =>
			slotOf(frame.url()) === slotB &&
			frame.url().includes('/controllerFrame.html'),
	);
const agentShares = await agentOfB?.evaluate((name) => {
	const share = Object.getOwnPropertyDescriptor(window, `${name}$slot`)?.value;
	const frames = [];
	for (let i = 0; i < parent.length; i++)
		for (let j = 0; j < parent[i].length; j++)
			try {
				const client = parent[i][j][name];
				if (client) frames.push(client.sharedRewriter === share?.rewriter);
			} catch (error) {
				// another origin's
			}
	return { library: typeof share?.rewriter === 'object', frames };
}, clientName);
ok(
	"a frame of another slot than its page's rewrites in its slot agent's library",
	agentShares?.library === true &&
		agentShares.frames.length > 0 &&
		agentShares.frames.every(Boolean),
	JSON.stringify(agentShares ?? 'no agent'),
);
ok(
	'and its eval is rewritten there, answering what it answers natively',
	(await asPage(ab2, 'return eval("location.href")')) === `${B}${PAGE}?ab2`,
	await asPage(ab2, 'return eval("location.href")'),
);

// the single-origin controller: both sites share the proxy origin's process
const sa = await show(
	'single',
	`${A}${PAGE}?sa&child=${encodeURIComponent(`${B}${PAGE}?sab`)}`,
	(url) => url.startsWith(PROXY) && url.includes('/stomp/'),
);
const sab = await childOf(sa.frame, (url) => url.includes('/stomp/'));
const single = await observe(sa.frame, sab);
ok(
	'the single-origin controller still shows both sites in one process',
	single.gap >= 280 &&
		!(await oopifs()).some((url) => url.startsWith(PROXY)) &&
		slotOf(sab.url()) === new URL(PROXY).origin,
	`${single.gap} ms`,
);
ok(
	'and each side of a message sees the same origins there',
	single.rtt.child === nativeCross.rtt.child &&
		single.rtt.parent === nativeCross.rtt.parent,
	JSON.stringify(single.rtt),
);
// a message between two sites takes a process hop with the pool, as
// natively, and none without
console.log(
	`message round trip, median ms: natively ${nativeCross.rtt.median.toFixed(2)}, pool ${cross.rtt.median.toFixed(2)}, single origin ${single.rtt.median.toFixed(2)}`,
);
console.log(
	`timers held up by the parent's 300 ms: natively ${nativeCross.gap}, pool ${cross.gap}, single origin ${single.gap}`,
);
if (TIMING)
	ok(
		'a message to another site and back takes a process hop, about the time it takes natively',
		cross.rtt.median > single.rtt.median &&
			cross.rtt.median > nativeCross.rtt.median / 4 &&
			cross.rtt.median < nativeCross.rtt.median * 4 + 3,
		`${cross.rtt.median} ms (natively ${nativeCross.rtt.median} ms, single origin ${single.rtt.median} ms)`,
	);

// a pool of one slot: both sites share it, as every site does without a pool
const oa = await show(
	'one',
	`${A}${PAGE}?oa&child=${encodeURIComponent(`${B}${PAGE}?oab`)}`,
	inPool([SLOTS[3]]),
);
const oab = await childOf(oa.frame, inPool([SLOTS[3]]));
const shared = await observe(oa.frame, oab);
ok(
	'with more sites than slots, sites share a slot and its process',
	slotOf(oa.frame.url()) === SLOTS[3] &&
		slotOf(oab.url()) === SLOTS[3] &&
		shared.gap >= 280,
	`${oa.frame.url()} ${oab.url()} ${shared.gap} ms`,
);
ok(
	'and are still two origins to each other',
	shared.rtt.child === nativeCross.rtt.child &&
		shared.rtt.parent === nativeCross.rtt.parent &&
		(await asPage(oab, 'return location.href')) === `${B}${PAGE}?oab`,
	JSON.stringify(shared.rtt),
);
await oa.frame.evaluate(() => localStorage.setItem('sp-one', 'a'));
ok(
	'with storage of their own',
	(await oab.evaluate(() => localStorage.getItem('sp-one'))) === null,
);

// storage
await a.frame.evaluate(async () => {
	localStorage.setItem('sp', 'a');
	await new Promise((resolve) => {
		const open = indexedDB.open('sp-db');
		open.onsuccess = () => {
			open.result.close();
			resolve();
		};
		open.onerror = resolve;
	});
});
const b = await show('pool', `${B}${PAGE}?b`, inPool(POOL));
ok(
	'a site has the same slot as a page and as a frame',
	slotOf(b.frame.url()) === slotB,
	b.frame.url(),
);
const other = await b.frame.evaluate(async () => [
	localStorage.getItem('sp'),
	(await indexedDB.databases()).some((d) => d.name === 'sp-db'),
]);
ok(
	'another site sees none of the first one storage or databases',
	other[0] === null && !other[1],
	JSON.stringify(other),
);
const a2 = await show('pool', `${A}${PAGE}?a2`, inPool(POOL));
const sameSite = await a2.frame.evaluate(async () => [
	localStorage.getItem('sp'),
	(await indexedDB.databases()).some((d) => d.name === 'sp-db'),
]);
ok(
	'a second frame of the same site is in its slot and sees its storage and databases',
	slotOf(a2.frame.url()) === slotA && sameSite[0] === 'a' && sameSite[1],
	JSON.stringify(sameSite),
);

// the jar is one for every slot. B's own cookies, set in B's slot, on a
// request A's page makes to B, which A's slot's worker sends
await asPage(
	b.frame,
	`document.cookie = 'sp_none=1; path=/; SameSite=None; Secure';
	document.cookie = 'sp_lax=1; path=/';`,
);
await asPage(
	a2.frame,
	`return fetch(${JSON.stringify(`${B}echo-headers?k=${run}-pc`)}, { mode: 'no-cors', credentials: 'include' }).then(() => 0)`,
);
const proxiedCookie = (await recorded(`${run}-pc`))?.cookie ?? '';
ok(
	"natively, a page's request to another site carries that site's SameSite=None cookie",
	nativeCookie.includes('sp_none=1') && !nativeCookie.includes('sp_lax'),
	nativeCookie,
);
ok(
	"a request from one slot carries the cookies another slot's site set, as natively",
	proxiedCookie === nativeCookie,
	`${proxiedCookie} (natively ${nativeCookie})`,
);
// a cookie a response sets for B on a request of A's page (A's slot's
// worker stores it) is B's own, read in B's slot
await asPage(
	a2.frame,
	`return fetch(${JSON.stringify(`${B}pages/site-pool-cookie.txt`)}, { mode: 'no-cors', credentials: 'include' }).then(() => 0)`,
);
let crossSet = '';
for (let i = 0; i < 40 && !crossSet.includes('sp_set=1'); i++) {
	await sleep(100);
	crossSet = await asPage(b.frame, 'return document.cookie');
}
ok(
	"a cookie a site's response set through another slot is read in the site's own",
	crossSet.includes('sp_set=1'),
	crossSet,
);
// the same pool in another order is another assignment: B is shown from
// another slot there, with the same cookies, and without what its pages
// stored in the first one, which is why a site keeps its slot
await b.frame.evaluate(() => localStorage.setItem('sp-b', 'b'));
await page.evaluate(async (POOL) => {
	window.rotated = window.make({
		sitePool: { origins: [...POOL.slice(1), POOL[0]] },
	});
	await window.rotated.wait();
}, POOL);
await show('rotated', `${A}${PAGE}?ra`, inPool(POOL));
const rb = await show('rotated', `${B}${PAGE}?rb`, inPool(POOL));
const moved = await asPage(
	rb.frame,
	"return [document.cookie, localStorage.getItem('sp-b')]",
);
ok(
	'a site shown from another slot has its cookies',
	slotOf(rb.frame.url()) !== slotB &&
		moved[0].includes('sp_none=1') &&
		moved[0].includes('sp_lax=1') &&
		moved[0].includes('sp_set=1'),
	`${rb.frame.url()} ${JSON.stringify(moved)}`,
);
ok(
	"and not what its pages stored in the first slot (a site's storage is its slot's)",
	moved[1] === null,
	JSON.stringify(moved),
);
// a later controller with the same pool finds every site where it was
await page.evaluate(async (POOL) => {
	window.later = window.make({ sitePool: { origins: POOL } });
	await window.later.wait();
}, POOL);
const lb = await show('later', `${B}${PAGE}?lb`, inPool(POOL));
const la = await show('later', `${A}${PAGE}?la`, inPool(POOL));
ok(
	'a site keeps its slot from one controller to the next, and its storage with it',
	slotOf(lb.frame.url()) === slotB &&
		slotOf(la.frame.url()) === slotA &&
		(await asPage(lb.frame, "return localStorage.getItem('sp-b')")) === 'b',
	`${lb.frame.url()} ${la.frame.url()}`,
);

// a link from A to B
const linkKey = `${run}-pl`;
const link = await show(
	'pool',
	`${A}${PAGE}?to=${encodeURIComponent(`${B}echo-headers?k=${linkKey}`)}`,
	inPool([slotA]),
);
await click(link.frame, '#to');
const linked = await frameOf(link.element, inPool([slotB]));
ok(
	'a link to another site leaves for that site slot',
	slotOf(linked.url()) === slotB,
	linked.url(),
);
const proxiedLink = await recorded(linkKey);
for (const name of ['referer', 'sec-fetch-site', 'sec-fetch-mode', 'origin'])
	ok(
		`the link's ${name} is Chrome's`,
		proxiedLink?.[name] === nativeLink?.[name],
		`${proxiedLink?.[name]} (natively ${nativeLink?.[name]})`,
	);

// a form POST from A to B
const postKey = `${run}-pp`;
const post = await show(
	'pool',
	`${A}${PAGE}?to=${encodeURIComponent(`${B}echo-headers?k=${postKey}`)}`,
	inPool([slotA]),
);
await post.frame.evaluate(() => document.getElementById('post').submit());
const posted = await frameOf(post.element, inPool([slotB]));
ok(
	'a form POST to another site leaves for that site slot',
	slotOf(posted.url()) === slotB,
	posted.url(),
);
const proxiedPost = await recorded(postKey);
for (const name of [
	'referer',
	'origin',
	'sec-fetch-site',
	'content-type',
	'content-length',
])
	ok(
		`the POST's ${name} is Chrome's`,
		proxiedPost?.[name] === nativePost?.[name],
		`${proxiedPost?.[name]} (natively ${nativePost?.[name]})`,
	);

// a document of B reached by a link, its referrer and history
const nav = await show(
	'pool',
	`${A}${PAGE}?to=${encodeURIComponent(`${B}${PAGE}?landed`)}`,
	inPool([slotA]),
);
await click(nav.frame, '#to');
const landed = await frameOf(nav.element, inPool([slotB]));
ok(
	'the new document has the real location and referrer',
	(await asPage(landed, 'return [location.href, document.referrer]')).join(
		' ',
	) === `${B}${PAGE}?landed ${A}`,
	JSON.stringify(
		await asPage(landed, 'return [location.href, document.referrer]'),
	),
);
await sleep(500);
ok(
	'the hub frame follows the page to the other site',
	(await page.evaluate(() => window.pool.frames.at(-1).url)) ===
		`${B}${PAGE}?landed`,
	await page.evaluate(() => window.pool.frames.at(-1).url),
);
await landed.evaluate(() => history.back());
const back = await frameOf(nav.element, inPool([slotA]));
ok(
	'history.back() returns to the first site document in its slot',
	slotOf(back.url()) === slotA &&
		(await asPage(back, 'return location.href')).startsWith(`${A}${PAGE}?to=`),
	back.url(),
);

// the hub's own Back and Forward step the frame across the two slots
const toolbar = await show(
	'pool',
	`${A}${PAGE}?to=${encodeURIComponent(`${B}${PAGE}?toolbar`)}`,
	inPool([slotA]),
);
await click(toolbar.frame, '#to');
await frameOf(toolbar.element, inPool([slotB]));
await sleep(500);
const stepped = await page.evaluate(async () => {
	const frame = window.pool.frames.at(-1);
	const back = await frame.back();
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const there = frame.url;
	const forward = await frame.forward();
	await new Promise((resolve) => setTimeout(resolve, 1500));
	return [back, there, forward, frame.url];
});
ok(
	"the hub's Back steps the frame back to the first site",
	stepped[0] === true && stepped[1]?.startsWith(`${A}${PAGE}?to=`),
	JSON.stringify(stepped),
);
ok(
	"the hub's Forward steps it to the second site again",
	stepped[2] === true && stepped[3] === `${B}${PAGE}?toolbar`,
	JSON.stringify(stepped),
);

// a frame of another slot aims a link, a form and window.open at the top:
// the browser would not let it navigate the proxied top (the host frames it
// sandboxed), so its inject asks the top's to go there itself. The top
// leaves for the destination's slot, the host page stays, and the request
// is a top-level document's, as natively. The request's initiator
// (Referer, Origin, Sec-Fetch-Site) is natively the frame; through the
// proxy it is the top for a link and a form, with either controller
for (const [way, button] of Object.entries(TOP_WAYS)) {
	const seen = {};
	for (const mode of ['pool', 'single']) {
		const key = `${run}-${mode}-t-${way}`;
		const hub = page.url();
		const shown = await show(
			mode,
			`${A}${PAGE}?t&child=${encodeURIComponent(topChild(key))}`,
			mode === 'pool' ? inPool([slotA]) : (url) => url.includes('/stomp/'),
		);
		const frame = await childOf(shown.frame, (url) =>
			mode === 'pool' ? inPool([slotB])(url) : url.includes('/stomp/'),
		);
		await click(frame, button);
		seen[mode] = (await recorded(key)) ?? {};
		await sleep(500);
		const top = await shown.element.contentFrame();
		seen[mode].slot = slotOf(top?.url() ?? '');
		seen[mode].hub = page.url() === hub;
	}
	const pool = seen.pool;
	ok(
		`a ${way} aimed at the top from a frame of another slot navigates the top, as natively`,
		pool?.['sec-fetch-dest'] === nativeTop[way]?.['sec-fetch-dest'] &&
			pool?.['sec-fetch-mode'] === nativeTop[way]?.['sec-fetch-mode'] &&
			pool.hub,
		`${pool?.['sec-fetch-dest']} ${pool?.['sec-fetch-mode']} (natively ${nativeTop[way]?.['sec-fetch-dest']} ${nativeTop[way]?.['sec-fetch-mode']})`,
	);
	ok(
		`and the top leaves for the destination site slot`,
		pool?.slot === slotB,
		pool?.slot,
	);
	if (way === 'form')
		for (const name of ['content-type', 'content-length'])
			ok(
				`the top form's ${name} is Chrome's`,
				pool?.[name] === nativeTop[way]?.[name],
				`${pool?.[name]} (natively ${nativeTop[way]?.[name]})`,
			);
	// (docs/site-pool.md, Open): printed, not checked
	for (const name of ['referer', 'origin', 'sec-fetch-site', 'sec-fetch-user'])
		console.log(
			`top ${way} ${name}: pool ${pool?.[name]}, single origin ${seen.single?.[name]}, natively ${nativeTop[way]?.[name]}`,
		);
}

// and the document the top shows then is the destination, which the hub
// frame reports
const topLink = await show(
	'pool',
	`${A}${PAGE}?tl&child=${encodeURIComponent(`${B}${PAGE}?target=_top&to=${encodeURIComponent(`${B}${PAGE}?top-landed`)}`)}`,
	inPool([slotA]),
);
await click(await childOf(topLink.frame, inPool([slotB])), '#to');
const topLanded = await frameOf(topLink.element, inPool([slotB]));
await sleep(500);
ok(
	'the top shows the destination from its slot, and the hub frame reports it',
	(await asPage(topLanded, 'return location.href')) ===
		`${B}${PAGE}?top-landed` &&
		(await page.evaluate(() => window.pool.frames.at(-1).url)) ===
			`${B}${PAGE}?top-landed`,
	`${await asPage(topLanded, 'return location.href')} ${await page.evaluate(() => window.pool.frames.at(-1).url)}`,
);

// a page whose policy restricts frames (the Guardian's `child-src https:`,
// a frame-src or default-src that names the other site) or forms: the
// frames of another site it allows are shown from that site's slot (a 307
// the browser judges by its copy of the policy) and load as natively; the
// ones it refuses, and a redirect to the other site it refuses, are refused
// with the violation Chrome fires, naming the page's URLs and no slot
// (test/csp-server.mjs, test/pages/csp-probes.js)
{
	const other = OTHER.replace(/\/$/, '');
	const CSP_CASES = {
		'frame-src by scheme': {
			p: 'frame-src http: https:',
			probes: ['frame-other', 'frame-other-path', 'frame-redirect-other'],
		},
		'child-src by scheme': {
			p: 'child-src http: https:',
			probes: ['frame-other', 'frame-other-path'],
		},
		'default-src naming the other site': {
			p: `default-src 'self' ${other}; script-src 'self' 'unsafe-inline'`,
			probes: ['frame-self', 'frame-other', 'frame-redirect-other'],
		},
		"frame-src 'self'": {
			p: "frame-src 'self'",
			probes: ['frame-self', 'frame-other', 'frame-redirect-other'],
		},
		"a report-only frame-src 'self'": {
			ro: "frame-src 'self'",
			probes: ['frame-other'],
		},
		'form-action naming the other site': {
			s: 'nav',
			p: `form-action 'self' ${other}`,
			probes: ['form-frame-other'],
		},
		"a report-only form-action 'self'": {
			s: 'nav',
			ro: "form-action 'self'",
			probes: ['form-frame-other'],
		},
	};
	const FIELDS = [
		'blockedURI',
		'violatedDirective',
		'effectiveDirective',
		'disposition',
		'documentURI',
	];
	// a frame that loaded and said so (a form's frame: its destination did)
	const loaded = (result) => /^messages? (frame|arrived)/.test(String(result));
	const loads = (results) => Object.values(results ?? {}).filter(loaded).length;
	const nativeCsp = await context.newPage();
	const proxiedCsp = {};
	const nativeCases = {};
	for (const [name, spec] of Object.entries(CSP_CASES)) {
		await nativeCsp.goto(caseURL(name, spec));
		nativeCases[name] = await report(nativeCsp, name);
	}
	await nativeCsp.close();
	for (const [name, spec] of Object.entries(CSP_CASES)) {
		const shown = await show('pool', caseURL(name, spec), inPool([slotA]));
		const got = await report(page, name);
		// the slots its frames of the other site were shown from
		const slots = (shown.frame?.childFrames() ?? [])
			.map((child) => slotOf(child.url()))
			.filter((slot) => slot !== slotA && POOL.includes(slot));
		proxiedCsp[name] = { got, slots };
		await shown.element.evaluate((element) => element.remove());
	}
	for (const [name, spec] of Object.entries(CSP_CASES)) {
		const want = nativeCases[name];
		const { got, slots } = proxiedCsp[name];
		ok(
			`csp: ${name}: natively, every probe ran`,
			want?.done &&
				spec.probes.every(
					(probe) =>
						want.results[probe] &&
						!String(want.results[probe]).includes('no such probe'),
				),
			JSON.stringify(want?.results),
		);
		// (a form probe's `log` is the fixture's record of the request, read
		// a moment after the destination said it arrived: it races, natively
		// too)
		const outcome = (result) => String(result).replace(/; log .*$/s, '');
		const differing = spec.probes.filter(
			(probe) =>
				outcome(want?.results?.[probe]) !== outcome(got?.results?.[probe]),
		);
		ok(
			`csp: ${name}: every frame loads or is refused as natively (${loads(want?.results)} loaded natively, ${loads(got?.results)} from the pool)`,
			got?.done && differing.length === 0,
			JSON.stringify(
				Object.fromEntries(
					differing.map((probe) => [
						probe,
						[want?.results?.[probe], got?.results?.[probe]],
					]),
				),
			),
		);
		const wanted = shape(want?.events, FIELDS);
		const seen = shape(got?.events, FIELDS);
		ok(
			`csp: ${name}: the violations are the native ones`,
			got?.done && JSON.stringify(wanted) === JSON.stringify(seen),
			JSON.stringify({ native: wanted, pool: seen }).slice(0, 2000),
		);
		const leaked = (got?.events ?? []).filter((event) =>
			['blockedURI', 'documentURI', 'referrer', 'sourceFile'].some((field) =>
				SLOTS.some((slot) => String(event[field] ?? '').startsWith(slot)),
			),
		);
		ok(
			`csp: ${name}: no violation names a slot`,
			got?.done && leaked.length === 0,
			JSON.stringify(leaked).slice(0, 1000),
		);
		// (a form's frame is gone by the time the probe answers)
		const others = spec.probes.filter(
			(probe) =>
				probe.startsWith('frame-') &&
				probe !== 'frame-self' &&
				loaded(want?.results?.[probe]),
		);
		if (others.length)
			ok(
				`csp: ${name}: the frames of the other site are shown from another slot`,
				slots.length > 0 && slots.every((slot) => slot === slotB),
				JSON.stringify(slots),
			);
	}
}

// what a slot costs the first document shown from it: its agent starts and
// its service worker installs (a slot no controller above used), when the
// document is asked for as soon as the controller is up
await page.evaluate(async (slot) => {
	window.cold = window.make({ sitePool: { origins: [slot] } });
	await window.cold.wait();
}, SLOTS[4]);
const timed = async (controller, name) => {
	const start = Date.now();
	await show(controller, `${A}${PAGE}?${name}`, (url) =>
		url.includes('/stomp/'),
	);
	return Date.now() - start;
};
const coldMs = await timed('cold', 'cold');
const warmMs = await timed('cold', 'warm');
const singleMs = await timed('single', 'single-timed');
console.log(
	`first document, ms: from a slot never used ${coldMs}, from the same slot again ${warmMs}, single origin ${singleMs}`,
);
ok(
	'a slot never used shows its first document',
	coldMs > 0 && warmMs > 0,
	`${coldMs} ms, then ${warmMs} ms`,
);

// and once the page was idle: a pool controller starts the agent of the slot
// the next new site would get, its spare (SiteHub.warm), before any site is
// shown from it, so that site's first document does not wait for the slot
await page.evaluate(async (slot) => {
	window.spare = window.make({ sitePool: { origins: [slot] } });
	await window.spare.wait();
}, SLOTS[5]);
const spareAgent = async () =>
	(await oopifs()).some(
		(url) => slotOf(url) === SLOTS[5] && url.includes('/controllerFrame.html'),
	);
let spareUp = false;
for (let i = 0; i < 100 && !(spareUp = await spareAgent()); i++)
	await sleep(100);
ok(
	'an idle pool controller starts its spare slot, before any site is shown from it',
	SLOTS[5] !== undefined && spareUp,
	`${SLOTS[5]}: ${(await oopifs()).filter((url) => slotOf(url) === SLOTS[5]).length} frames`,
);
// its worker installs and its controller shakes hands meanwhile
await sleep(2000);
const spareMs = await timed('spare', 'spare');
console.log(
	`first document, ms: from a spare slot (started while the page was idle) ${spareMs}`,
);

// the blocker in a slot: a slot's worker blocks, hides and runs the
// scriptlets the lists say, as the host origin's worker does for the same
// page (a thin slot asks the host's worker's engine). A content blocker has
// no native answer: the single-origin controller with the same lists is
// the reference.
await page.evaluate(
	async ({ adblock, POOL }) => {
		window.blocking = window.make({ sitePool: { origins: POOL }, adblock });
		window.blockingSingle = window.make({ adblock });
		await Promise.all([window.blocking.wait(), window.blockingSingle.wait()]);
	},
	{ adblock: ADBLOCK, POOL },
);
const BLOCKING_PROBE = `return (async () => {
	const load = (src) => new Promise((resolve) => {
		const script = document.createElement('script');
		script.src = src;
		script.onload = () => resolve('loaded');
		script.onerror = () => resolve('error');
		document.head.append(script);
	});
	const r = {
		blocked: await load('/pages/adblock-blocked.js?' + Math.random()),
		allowed: await load('/pages/adblock-allowed.js?' + Math.random()),
	};
	const specific = document.createElement('div');
	specific.className = 'adblock-specific';
	specific.textContent = 'ad';
	const generic = document.createElement('div');
	generic.className = 'adblock-generic';
	generic.textContent = 'ad';
	document.body.append(specific, generic);
	const hidden = (element) => getComputedStyle(element).display === 'none';
	for (let i = 0; i < 50 && !(hidden(specific) && hidden(generic)); i++)
		await new Promise((resolve) => setTimeout(resolve, 100));
	r.specific = hidden(specific);
	r.generic = hidden(generic);
	r.scriptlet = typeof window.__adblockSpy;
	return r;
})()`;
const blockingIn = async (controller, name, test) =>
	asPage(
		(await show(controller, `${A}${PAGE}?${name}`, test)).frame,
		BLOCKING_PROBE,
	);
const blockedSingle = await blockingIn(
	'blockingSingle',
	'blocking-single',
	(url) => slotOf(url) === slotOf(PROXY) && url.includes('/stomp/'),
);
const blockedSlot = await blockingIn('blocking', 'blocking-slot', inPool(POOL));
console.log(
	`blocker: single origin ${JSON.stringify(blockedSingle)}, slot ${JSON.stringify(blockedSlot)}`,
);
ok(
	'the single-origin controller blocks, hides and runs what the lists say',
	blockedSingle.blocked === 'error' &&
		blockedSingle.allowed === 'loaded' &&
		blockedSingle.specific &&
		blockedSingle.generic,
	JSON.stringify(blockedSingle),
);
ok(
	"a slot's worker (the host worker's engine) does the same",
	JSON.stringify(blockedSlot) === JSON.stringify(blockedSingle),
	JSON.stringify(blockedSlot),
);

// every service worker stopped (the browser stops idle ones): a slot's
// worker comes back knowing no controller, and its agent shakes hands again
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await sleep(500);
const revived = await show('pool', `${A}${PAGE}?revived`, inPool([slotA]));
ok(
	"a slot's stopped worker serves again once its agent shook hands",
	(await asPage(revived.frame, 'return location.href')) ===
		`${A}${PAGE}?revived`,
	revived.frame.url(),
);
ok(
	'and still asks the one jar',
	(await asPage(revived.frame, 'return document.cookie')) === '' &&
		(
			await asPage(
				(await show('pool', `${B}${PAGE}?revived-b`, inPool([slotB]))).frame,
				'return document.cookie',
			)
		).includes('sp_set=1'),
);
const crossed = await show(
	'pool',
	`${A}${PAGE}?to=${encodeURIComponent(`${B}${PAGE}?revived`)}`,
	inPool([slotA]),
);
await cdp.send('ServiceWorker.stopAllWorkers');
await sleep(500);
await click(crossed.frame, '#to');
const crossedTo = await frameOf(crossed.element, inPool([slotB]));
ok(
	'a link to another site still leaves for its slot after the workers stopped',
	(await asPage(crossedTo, 'return location.href')) === `${B}${PAGE}?revived`,
	crossedTo.url(),
);
// and the blocker still answers in a slot (a thin slot's port to the host
// worker closed with it: its worker asks its agent for another)
await cdp.send('ServiceWorker.stopAllWorkers');
await sleep(500);
const blockedRevived = await blockingIn(
	'blocking',
	'blocking-revived',
	inPool(POOL),
);
ok(
	"a slot's stopped worker blocks as before once it serves again",
	JSON.stringify(blockedRevived) === JSON.stringify(blockedSingle),
	JSON.stringify(blockedRevived),
);

await done(browser, errors);
