// Chrome's network state partitioning, against Chrome: the connections a
// page's requests go out on are keyed by the top-level site (and whether
// the frame is cross-site to it) and by credentials, so a site cannot tell
// from a request's timing that another site warmed a connection to a
// third. A page of each site (test/pages/net-part.html) asks a third site's
// server which of its connections each request came on (/sop/conn,
// test/sop-server.mjs): twice without credentials, once with; then loads
// a cacheable resource of the third site and asks how many of its loads
// reached it (the HTTP cache, which sop-partitions measures in full). The
// connections are labelled in the order they first appear, and the labels
// of each step are compared with the same steps loaded natively, in both
// modes (docs/same-origin-policy.md). Measured in Chrome 157: a connection
// is a top-level site's, apart for a context cross-site to it, and apart
// again for requests with credentials. Through the proxy every partition's
// connections are wisp streams of the one wisp connection: the transport
// worker opens no wisp WebSocket for a new site (counted over CDP).
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

const A = new URL(FIXTURE).origin;
const B = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
// the third site, whose server every step reaches
const C = B.replace('localhost', 'c.localhost');
const part = (role, t, site) =>
	`${site}/pages/net-part.html?role=${role}&t=${t}&c=${encodeURIComponent(C)}`;
const framing = (site, src) =>
	`${site}/pages/net-part-top.html?src=${encodeURIComponent(src)}`;
/** the steps, their names under the run's own tag */
const steps = (t) => [
	['a', part('a', t, A)],
	['b', part('b', t, B)],
	// a frame of A under B: B's top-level site, cross-site to it
	['a-in-b', framing(B, part('a-in-b', t, A))],
	// a frame of B under A: A's top-level site, cross-site to it
	['b-in-a', framing(A, part('b-in-a', t, B))],
	['a/again', part('a/again', t, A)],
];

/** the report of `role` from whichever frame of `page` has it */
async function report(page, role) {
	for (let i = 0; i < 120; i++) {
		for (const frame of page.frames()) {
			const value = await frame?.evaluate(() => window.__net).catch(() => null);
			if (value?.done && value.role === role) return value;
		}
		await sleep(250);
	}
	return null;
}

/** a labeller: each connection's letter, in the order they first appear */
function labeller() {
	const labels = new Map();
	return (n) => {
		if (n === undefined || n === null) return '?';
		if (!labels.has(n)) labels.set(n, String.fromCharCode(97 + labels.size));
		return labels.get(n);
	};
}

/**
 * Each step's connections as labels: those without credentials and those
 * with are labelled apart, so each comparison stands alone, and whether the
 * two of a step are one connection is a field of its own
 */
function labelled(reports) {
	const plain = labeller();
	const credentialed = labeller();
	const out = {};
	for (const [key, value] of Object.entries(reports))
		out[key] = {
			plain: (value?.plain ?? []).map(plain).join(''),
			credentialed: credentialed(value?.credentialed),
			'credentialed on the connection without':
				value?.plain?.[0] !== undefined &&
				value?.plain?.[0] === value?.credentialed,
			cacheLoads: value?.cacheLoads ?? null,
			error: value?.error ?? null,
		};
	return out;
}

// Checks known to differ from Chrome, by why (docs/same-origin-policy.md). A
// check on the list that now reads as natively fails too: take it off.
const KNOWN_BY_REASON = {
	'one pool for requests with and without credentials (another wisp connection per partition)':
		['a', 'b', 'a-in-b', 'b-in-a', 'a/again'].map(
			(key) => `${key}: credentialed on the connection without`,
		),
};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);
const FIELDS = [
	'plain',
	'credentialed',
	'credentialed on the connection without',
	'cacheLoads',
	'error',
];

/**
 * The wisp WebSockets the transport workers open from now on, over CDP (a
 * browser session, each worker through its own): `count()` says how many
 */
async function wispSockets(browser) {
	const cdp = await browser.newBrowserCDPSession();
	let opened = 0;
	let id = 0;
	cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
		const { method, params } = JSON.parse(message);
		if (method === 'Network.webSocketCreated' && /\/wisp\//.test(params.url))
			opened++;
	});
	const attached = new Set();
	const attach = async () => {
		const { targetInfos } = await cdp.send('Target.getTargets');
		for (const target of targetInfos) {
			if (target.type !== 'worker' || !/transportWorker/.test(target.url))
				continue;
			if (attached.has(target.targetId)) continue;
			attached.add(target.targetId);
			const { sessionId } = await cdp.send('Target.attachToTarget', {
				targetId: target.targetId,
				flatten: false,
			});
			await cdp.send('Target.sendMessageToTarget', {
				sessionId,
				message: JSON.stringify({ id: ++id, method: 'Network.enable' }),
			});
		}
	};
	await attach();
	return {
		attach,
		count: () => opened,
		workers: () => attached.size,
	};
}

const browser = await launch(['--disable-features=PaintHolding']);

const nativeContext = await browser.newContext();
const nativeReports = {};
for (const [key, url] of steps('native')) {
	const page = await nativeContext.newPage();
	await page.goto(url);
	nativeReports[key] = await report(page, key);
	await page.close();
}
await nativeContext.close();
const native = labelled(nativeReports);
console.log('native', JSON.stringify(native));
ok(
	'natively, every step reported',
	steps('native').every(([key]) => nativeReports[key] && !native[key].error),
	JSON.stringify(nativeReports),
);
// what the comparison relies on, so a change in the browser shows here first
ok(
	'natively, a site reuses its own connection',
	native.a.plain[0] === native.a.plain[1] &&
		native['a/again'].plain[0] === native.a.plain[0],
	JSON.stringify(native),
);
ok(
	"natively, another top-level site does not get a site's connection",
	native.b.plain[0] !== native.a.plain[0],
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const sockets = await wispSockets(browser);
	const reports = {};
	for (const [key, url] of steps(mode.replace('-', ''))) {
		await page.click('#home').catch(() => {});
		await submitLanding(page, url);
		reports[key] = await report(page, key);
		await sockets.attach();
	}
	// the first may open after the worker was found, while the landing
	// page's controller starts; none more for the sites after it
	ok(
		`${mode}: the transport opened at most one wisp WebSocket over the five steps`,
		sockets.workers() > 0 && sockets.count() <= 1,
		`${sockets.count()} opened, ${sockets.workers()} transport workers watched`,
	);
	const proxied = labelled(reports);
	console.log(mode, JSON.stringify(proxied));
	for (const [key] of steps(mode))
		for (const field of FIELDS) {
			const name = `${key}: ${field}`;
			const a = JSON.stringify(native[key]?.[field] ?? null);
			const b = JSON.stringify(proxied[key]?.[field] ?? null);
			const detail = `\n      native  ${a}\n      proxied ${b}`;
			if (KNOWN.has(name))
				ok(
					`${mode}: ${name} differs as known (${KNOWN.get(name)})`,
					a !== b,
					`now as natively: take it off the list${detail}`,
				);
			else ok(`${mode}: ${name} as natively`, a === b, detail);
		}
	await page.context().close();
}

await browser.close();
await done();
