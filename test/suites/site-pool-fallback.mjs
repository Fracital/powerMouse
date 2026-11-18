// The site pool's fallbacks (ControllerInit.sitePool, docs/site-pool.md):
// where a slot cannot show sites, the controller shows them from its own
// page's origin, as without a pool, silently, page by page. Each case is a
// controller whose pool cannot work, showing a page of 127.0.0.1 with a
// frame of localhost (the site-pool suite's fixture), checked against
// Chrome's own load of the same page: the page and its frame show their
// documents at their real URLs, from the host's origin, with no error the
// page can see, and the first navigation waits about as long as it does
// with the single-origin controller (the suite prints how long each waited):
// - a slot whose port is closed;
// - one that accepts the connection and never answers (a network that
//   drops other ports than the host's);
// - one a front answers with a page of its own (not STomp);
// - one whose service worker does not register (a 404, a wrong MIME type);
// - one whose worker registers and is not STomp's (the agent's controller
//   never gets ready);
// - a page whose slots are not secure contexts (a LAN name over http:,
//   the host's own origin let through as secure by Chrome's flag);
// - `sitePool: false`, and a pool with no origins.
// Then a slot that stops after sites were shown from it (its agent removed
// by the host's page): a frame's go(), a link from another slot's document
// (the 307 its worker answers), the hub's Back and a site whose slot is
// kept for it all show from the host's origin, and the kept assignment is
// still the slot's.
// And a route of a site on the hub's own origin (a page that holds a proxy
// URL, a fallback's navigation) leaves for the site's slot, and stays on the
// hub's origin only when that slot does not answer.
import { createServer, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
	done,
	FIXTURE,
	launch,
	ok,
	PORT,
	PROXY,
	REWRITER,
	sleep,
} from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/site-pool.html';
const HOST = new URL(PROXY).origin;
const TIMING = process.env.SKIP_TIMING !== '1';

/** a server on a free port of 127.0.0.1, closed with the suite */
const servers = [];
async function listen(server) {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${server.address().port}`;
}

// a port nothing listens on
const closed = await (async () => {
	const probe = createNetServer();
	await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve));
	return `http://127.0.0.1:${port}`;
})();
// a port that takes the connection and says nothing
const silent = await listen(createNetServer(() => {}));
// a front that answers the port with a page of its own
const foreign = await listen(
	createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<!doctype html><title>Not here</title><p>Nothing to see.</p>');
	}),
);
/**
 * the demo server through a front of another port that answers the
 * service worker's script itself (`worker(res)`), with the header every
 * slot sends; `stop()` closes the front and every connection it holds
 */
async function front(worker) {
	const server = createServer((req, res) => {
		if (worker && /\/serviceWorker\.js(\?|$)/.test(req.url)) return worker(res);
		const upstream = request(
			{
				host: '127.0.0.1',
				port: Number(PORT),
				path: req.url,
				method: req.method,
				headers: req.headers,
			},
			(answer) => {
				res.writeHead(answer.statusCode, {
					...answer.headers,
					'origin-agent-cluster': '?1',
				});
				answer.pipe(res);
			},
		);
		upstream.on('error', () => res.destroy());
		req.pipe(upstream);
	});
	const origin = await listen(server);
	return {
		origin,
		stop: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}
const missing = await front((res) => {
	res.writeHead(404, { 'content-type': 'text/plain' });
	res.end('not found');
});
const wrongType = await front((res) => {
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('self.addEventListener("fetch", () => {});');
});
// a worker that registers, activates and answers nothing of STomp's
const stranger = await front((res) => {
	res.writeHead(200, {
		'content-type': 'text/javascript',
		'cache-control': 'no-store',
	});
	res.end(
		'self.addEventListener("install", () => self.skipWaiting());\n' +
			'self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));',
	);
});
// two good slots, and a third whose front stops once it showed a site
const good = [await front(), await front()];
const dying = await front();

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

/** the frame of an element handle, once it shows a document whose URL passes `test` */
async function frameOf(element, test = () => true, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await element.contentFrame();
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
const childOf = async (parent, test, ms) =>
	frameOf(await parent.$('#child'), test, ms);
const originOf = (url) => {
	try {
		return new URL(url).origin;
	} catch (error) {
		return null;
	}
};
const routed = (origin) => (url) =>
	originOf(url) === origin && url.includes('/stomp/');
/** `code` run in `frame` as the page's own code runs */
const asPage = (frame, code) =>
	frame.evaluate((code) => Function(code)(), code);

// --- natively: the page of A with its frame of B ---
const native = await context.newPage();
const nativeStart = Date.now();
await native.goto(
	`${A}${PAGE}?native&child=${encodeURIComponent(`${B}${PAGE}?nc`)}`,
);
const nativeChild = await childOf(native, (url) => url.startsWith(B));
const nativeMs = Date.now() - nativeStart;
const nativeSeen = {
	page: await native.evaluate(() => [location.origin, document.title]),
	child: await nativeChild.evaluate(() => [location.href, document.title]),
};
await native.close();

// --- proxied: the demo's page with controllers of the suite's own ---
await page.goto(`${PROXY}?nopool`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(
	async ({ rewriter }) => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		window.made = {};
		window.make = async (name, extra) => {
			const controller = new StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				...rewriter,
				...extra,
			});
			await controller.wait();
			window.made[name] = controller;
		};
		/** a frame of `name` at `url`: its element and how long go() took */
		window.show = async (name, url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 400px; height: 200px';
			document.body.append(element);
			const frame = window.made[name].createFrame(element);
			const start = performance.now();
			await frame.go(url);
			return { element, ms: Math.round(performance.now() - start) };
		};
	},
	{ rewriter: REWRITER },
);
const show = async (name, url, test) => {
	const handle = await page.evaluateHandle(
		({ name, url }) => window.show(name, url),
		{ name, url },
	);
	const element = (await handle.getProperty('element')).asElement();
	const ms = await (await handle.getProperty('ms')).jsonValue();
	return { element, ms, frame: await frameOf(element, test) };
};

/**
 * a page of A with a frame of B through controller `name`, each shown from
 * one of `origins` (the host's own by default)
 */
async function check(label, name, origins = [HOST], key = name) {
	const before = errors.length;
	const shown = await show(
		name,
		`${A}${PAGE}?${key}&child=${encodeURIComponent(`${B}${PAGE}?${key}-c`)}`,
		(url) => origins.some((origin) => routed(origin)(url)),
	);
	const child = await childOf(
		shown.frame,
		(url) => origins.some((origin) => routed(origin)(url)),
		20000,
	);
	const seen = {
		page: await asPage(shown.frame, 'return [location.origin, document.title]'),
		child: await asPage(child, 'return [location.href, document.title]'),
	};
	const where = [originOf(shown.frame.url()), originOf(child.url())];
	ok(
		`${label}: the page and its frame of another site show ${origins.every((origin) => origin === HOST) ? "from the host's origin" : origins.includes(HOST) ? "from the host's origin and a slot" : 'from the slots'}, at their real URLs, as natively`,
		origins.includes(where[0]) &&
			origins.includes(where[1]) &&
			seen.page[0] === nativeSeen.page[0] &&
			seen.page[1] === nativeSeen.page[1] &&
			seen.child[0] === `${B}${PAGE}?${key}-c` &&
			seen.child[1] === nativeSeen.child[1],
		`${where.join(' ')} ${JSON.stringify(seen)}`,
	);
	ok(
		`${label}: no error reaches the page`,
		errors.length === before,
		JSON.stringify(errors.slice(before)),
	);
	console.log(`${label}: the first navigation took ${shown.ms} ms`);
	return { ...shown, child, where };
}

// the single-origin controller and a pool that works, for the times
await page.evaluate(
	({ good }) =>
		Promise.all([
			window.make('single', {}),
			window.make('pool', { sitePool: { origins: good } }),
		]),
	{ good: good.map((slot) => slot.origin) },
);
const single = await check('the single-origin controller', 'single');
const pooled = await check(
	'a pool that works',
	'pool',
	good.map((slot) => slot.origin),
);
ok(
	'a pool that works shows the frame of another site from another slot',
	pooled.where[0] !== pooled.where[1],
	pooled.where.join(' '),
);

/**
 * a frame of the hub's page whose src is the route of `url` on the hub's
 * own origin (as a page holding a proxy URL, a link of the hub's origin or
 * a fallback navigates one), through controller `name`; its frame once it
 * shows a document of one of `origins`
 */
async function hubRoute(name, url, origins) {
	const element = (
		await page.evaluateHandle(
			async ({ name, url }) => {
				const routed = await window.made[name].route(url);
				const element = document.createElement('iframe');
				element.style.cssText = 'width: 400px; height: 200px';
				document.body.append(element);
				element.src = routed;
				return element;
			},
			{ name, url },
		)
	).asElement();
	const frame = await frameOf(element, (found) =>
		origins.some((origin) => routed(origin)(found)),
	);
	return {
		frame,
		where: originOf(frame.url()),
		seen: await asPage(frame, 'return [location.href, document.title]'),
		// the hub's page reads a document of its own origin
		hubReads: await element.evaluate((element) => {
			try {
				return !!element.contentDocument;
			} catch (error) {
				return false;
			}
		}),
	};
}

// a route of B on the hub's origin: natively the page is B's, apart from
// the page that holds it; with a pool, B's slot shows it
const hubRouted = await hubRoute('pool', `${B}${PAGE}?hub-route`, [
	HOST,
	...good.map((slot) => slot.origin),
]);
ok(
	"a route of another site on the hub's origin lands on that site's slot, apart from the hub's page, as natively",
	hubRouted.where === pooled.where[1] &&
		!hubRouted.hubReads &&
		hubRouted.seen[0] === `${B}${PAGE}?hub-route` &&
		hubRouted.seen[1] === nativeSeen.child[1],
	`${hubRouted.where} (B's slot ${pooled.where[1]}) ${JSON.stringify(hubRouted.seen)} hub reads it: ${hubRouted.hubReads}`,
);

/** what a fallback may add to the first navigation */
const bound = () => single.ms + 1500;
const FALLBACKS = [
	['a pool whose slot port is closed', 'closed', [closed]],
	['a pool whose slot port never answers', 'silent', [silent]],
	['a pool whose slot a front answers with its own page', 'foreign', [foreign]],
	[
		'a pool whose slot answers 404 for the service worker',
		'missing',
		[missing.origin],
	],
	[
		'a pool whose slot serves the service worker with a wrong MIME type',
		'wrongType',
		[wrongType.origin],
	],
	[
		"a pool whose slot's worker is not STomp's (the agent never gets ready)",
		'stranger',
		[stranger.origin],
	],
	['a pool of every kind of dead slot', 'all', null],
];
for (const [label, name, origins] of FALLBACKS) {
	const list = origins ?? [
		closed,
		silent,
		foreign,
		missing.origin,
		wrongType.origin,
		stranger.origin,
	];
	// each case is the sites' first visit to such a pool: a site keeps a
	// slot of any earlier list it is in, and the cases before gave them
	// theirs (a site kept on a dead slot is the case further down)
	await page.evaluate(async () => {
		const asked = (request) =>
			new Promise((resolve, reject) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		const db = await asked(indexedDB.open('kept-site-slots'));
		const tx = db.transaction('sites', 'readwrite');
		tx.objectStore('sites').delete('http://127.0.0.1');
		tx.objectStore('sites').delete('http://localhost');
		await new Promise((resolve) => (tx.oncomplete = resolve));
		db.close();
	});
	const started = Date.now();
	await page.evaluate(
		({ name, list }) => window.make(name, { sitePool: { origins: list } }),
		{
			name,
			list,
		},
	);
	const made = Date.now() - started;
	const shown = await check(label, name);
	if (TIMING)
		ok(
			`${label}: the first navigation waits about as long as without a pool`,
			shown.ms < bound(),
			`${shown.ms} ms (single origin ${single.ms} ms, natively ${nativeMs} ms for page and frame; the controller took ${made} ms to start)`,
		);
}
for (const [label, name, extra] of [
	['sitePool: false', 'off', { sitePool: false }],
	['a pool with no origins', 'empty', { sitePool: { origins: [] } }],
]) {
	await page.evaluate(({ name, extra }) => window.make(name, extra), {
		name,
		extra,
	});
	ok(
		`${label}: the controller does not show sites from a pool`,
		!(await page.evaluate((name) => window.made[name].siteMode, name)),
	);
	const shown = await check(label, name);
	if (TIMING)
		ok(
			`${label}: the first navigation waits as long as without a pool`,
			shown.ms < bound(),
			`${shown.ms} ms (single origin ${single.ms} ms)`,
		);
}

// --- a slot that stops after sites were shown from it ---
const DYING = [dying.origin, good[1].origin];
await page.evaluate(
	(list) => window.make('dies', { sitePool: { origins: list } }),
	DYING,
);
const before = await check(
	'a pool whose slot stops later',
	'dies',
	DYING,
	'd1',
);
ok(
	"before it stops, the page is shown from that slot and its frame from the other, as the pool's order gives",
	before.where[0] === dying.origin && before.where[1] === good[1].origin,
	before.where.join(' '),
);
// a frame whose history goes A (the slot that stops), then B (the other)
const walker = await show('dies', `${A}${PAGE}?walk`, routed(dying.origin));
await asPage(
	walker.frame,
	`location.href = ${JSON.stringify(`${B}${PAGE}?walk-b`)}`,
);
await frameOf(walker.element, (url) => routed(good[1].origin)(url));
// a frame of B whose link goes to A: B's slot's worker sends it on (a 307)
const linker = await show(
	'dies',
	`${B}${PAGE}?dl&to=${encodeURIComponent(`${A}${PAGE}?d-link`)}`,
	routed(good[1].origin),
);
// the agent's document goes (as when its renderer crashes, which takes its
// slot's documents along), and its port stops answering
await page.evaluate((origin) => {
	for (const element of document.querySelectorAll('iframe'))
		if (element.src.startsWith(origin)) element.src = 'about:blank';
}, dying.origin);
dying.stop();
await sleep(300);
const errorsBefore = errors.length;

let started = Date.now();
const gone = await show('dies', `${A}${PAGE}?d-go`, routed(HOST));
ok(
	"after the slot stopped, the hub's go() to a site of it shows it from the host's origin",
	originOf(gone.frame.url()) === HOST &&
		(await asPage(gone.frame, 'return location.href')) === `${A}${PAGE}?d-go`,
	`${gone.frame.url()} in ${Date.now() - started} ms`,
);
console.log(`go() to a site of a stopped slot took ${gone.ms} ms`);

started = Date.now();
await linker.frame.click('#to');
const linked = await frameOf(
	linker.element,
	(url) => originOf(url) === HOST && url.includes('/stomp/'),
	20000,
);
const linkedSeen = await asPage(
	linked,
	'return [location.href, document.referrer]',
);
ok(
	"a link from another slot's document to a site of the stopped slot lands on the host's origin, with its real URL and referrer",
	originOf(linked.url()) === HOST &&
		linkedSeen[0] === `${A}${PAGE}?d-link` &&
		linkedSeen[1] === `${B}`,
	`${linked.url()} ${JSON.stringify(linkedSeen)} in ${Date.now() - started} ms`,
);
console.log(
	`a link to a site of a stopped slot took ${Date.now() - started} ms`,
);

const back = await page.evaluate(() =>
	window.made.dies.frames.find((frame) => frame.url?.includes('walk-b')).back(),
);
const walked = await frameOf(
	walker.element,
	(url) => originOf(url) === HOST && url.includes('/stomp/'),
	20000,
);
ok(
	"the hub's Back to a document of the stopped slot shows it from the host's origin",
	back === true &&
		(await asPage(walked, 'return location.href')) === `${A}${PAGE}?walk`,
	`${back} ${walked.url()}`,
);
const forward = await page.evaluate(() =>
	window.made.dies.frames
		.find((frame) => frame.url?.endsWith('?walk'))
		.forward(),
);
const ahead = await frameOf(walker.element, (url) =>
	routed(good[1].origin)(url),
);
ok(
	'and its Forward to the other slot',
	forward === true &&
		(await asPage(ahead, 'return location.href')) === `${B}${PAGE}?walk-b`,
	`${forward} ${ahead.url()}`,
);
ok(
	'no error reaches the pages once the slot stopped',
	errors.length === errorsBefore,
	JSON.stringify(errors.slice(errorsBefore)),
);
// each site's slots, newest first: the first of the pool's is its own
const kept = await page.evaluate(async (list) => {
	const asked = (request) =>
		new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	const db = await asked(indexedDB.open('kept-site-slots'));
	const sites = db.transaction('sites').objectStore('sites');
	const [a, b] = await Promise.all([
		asked(sites.get('http://127.0.0.1')),
		asked(sites.get('http://localhost')),
	]);
	db.close();
	const own = (slots) => slots?.find((slot) => list.includes(slot));
	return { a: own(a), b: own(b), kept: { a, b } };
}, DYING);
ok(
	'the site keeps its slot (its data is there when the slot answers again)',
	kept.a === DYING[0] && kept.b === DYING[1],
	JSON.stringify(kept),
);
// a later controller of the same pool: the slot's site is kept for it,
// the slot does not answer, the site loads from the host's origin
await page.evaluate(
	(list) => window.make('kept', { sitePool: { origins: list } }),
	DYING,
);
const keptShown = await check(
	'a site whose kept slot does not answer',
	'kept',
	[HOST, good[1].origin],
);
ok(
	"a site whose kept slot does not answer shows from the host's origin, and its frame of a site whose slot answers from that slot",
	keptShown.where[0] === HOST && keptShown.where[1] === good[1].origin,
	keptShown.where.join(' '),
);
const keptRouted = await hubRoute('kept', `${A}${PAGE}?kept-route`, [
	HOST,
	...DYING,
]);
ok(
	"a route on the hub's origin of a site whose kept slot does not answer stays on the hub's origin",
	keptRouted.where === HOST &&
		keptRouted.seen[0] === `${A}${PAGE}?kept-route` &&
		keptRouted.seen[1] === nativeSeen.page[1],
	`${keptRouted.where} ${JSON.stringify(keptRouted.seen)}`,
);
if (TIMING)
	ok(
		'a site whose kept slot does not answer: the first navigation waits about as long as without a pool',
		keptShown.ms < bound(),
		`${keptShown.ms} ms (single origin ${single.ms} ms)`,
	);

// --- a page whose slots are not secure contexts: a LAN name over http:,
// the host's own origin let through as secure by Chrome's flag (a page that
// is not a secure context has no service worker, so no STomp at all) ---
const LAN = `http://stomp-lan.test:${PORT}`;
const lanBrowser = await launch([
	`--host-resolver-rules=MAP stomp-lan.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1`,
	`--unsafely-treat-insecure-origin-as-secure=${LAN}`,
]);
const lanPage = await lanBrowser.newPage();
const lanErrors = [];
lanPage.on('pageerror', (error) => lanErrors.push(error.message));
await lanPage.goto(`${LAN}/?nopool`);
await lanPage.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
// two slots that work from 127.0.0.1, named by the LAN name
const LAN_SLOTS = good.map((slot) =>
	slot.origin.replace('127.0.0.1', 'stomp-lan.test'),
);
const lan = await lanPage.evaluate(
	async ({ url, origins, rewriter }) => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		const controller = new StompController({
			serviceworker: window.controller.serviceworker,
			transport: window.controller.transport,
			directory: '/stomp/',
			codec: 'xor',
			...rewriter,
			sitePool: { origins },
		});
		await controller.wait();
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = controller.createFrame(element);
		const start = performance.now();
		await frame.go(url);
		return {
			secure: isSecureContext,
			ms: Math.round(performance.now() - start),
		};
	},
	{
		url: `${A}${PAGE}?lan&child=${encodeURIComponent(`${B}${PAGE}?lan-c`)}`,
		origins: LAN_SLOTS,
		rewriter: REWRITER,
	},
);
const lanFrame = lanPage
	.frames()
	.find(
		(frame) =>
			frame.url().includes('/stomp/') &&
			frame.parentFrame() === lanPage.mainFrame(),
	);
const lanChild =
	lanFrame &&
	(await childOf(lanFrame, (url) => url.includes('/stomp/'), 20000));
const lanSeen = lanChild && {
	page: await asPage(lanFrame, 'return [location.origin, document.title]'),
	child: await asPage(lanChild, 'return location.href'),
};
ok(
	"a host whose slots are not secure contexts: the page and its frame show from the host's origin, at their real URLs",
	lan.secure &&
		originOf(lanFrame?.url()) === LAN &&
		originOf(lanChild?.url()) === LAN &&
		lanSeen.page[0] === nativeSeen.page[0] &&
		lanSeen.child === `${B}${PAGE}?lan-c`,
	`${JSON.stringify(lan)} ${lanFrame?.url()} ${lanChild?.url()} ${JSON.stringify(lanSeen)}`,
);
ok(
	'a host whose slots are not secure contexts: no error reaches the page',
	lanErrors.length === 0,
	JSON.stringify(lanErrors),
);
console.log(
	`a host whose slots are not secure contexts: the first navigation took ${lan.ms} ms`,
);
await lanBrowser.close();

await done(browser, errors);
