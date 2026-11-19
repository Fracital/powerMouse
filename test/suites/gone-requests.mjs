// A document's requests end with it, against Chrome 157: what a document
// still has in flight when it goes (a fetch whose server has not answered)
// is cancelled, and the connection each held goes to the next request of
// that server, and so does one the page aborts while it waits for the
// answer. Through the proxy such a request went on holding one of its
// server's six connections (src/transport/socketPool.ts) until the server
// answered: a page's hanging requests outlived it, and the next page of the
// server waited behind them (2026-11-19: a page that left four requests its
// server holds a minute made the next visit's navigation wait 50 s,
// natively 11 ms). Fixed by src/server/clientRequests.ts (the requests of a
// client that is gone are given up) and SocketPool.cancel (a request given
// up lets its connection go).
//
// The suite's HTTP/1 server on 127.0.0.1 holds the requests a page leaves
// HOLD_MS before it answers them and counts what reaches it. Each step is a
// page of its that loads what it measures and reports to the same server
// as localhost (another host to Chrome, so the report never waits for a
// connection); the same pages load natively and in a proxied frame, and
// what the server saw is compared.
import { createServer } from 'node:http';
import { done, launch, ok, PROXY, sleep } from '../lib.mjs';

/** how long the server holds a request a page leaves */
const HOLD_MS = 6000;
/** how long it takes to answer the loads of the page after */
const DELAY_MS = 300;

/** what reached the server for each run, by its tag */
const runs = new Map();
const runOf = (tag) => {
	if (!runs.has(tag))
		runs.set(tag, { loads: [], inFlight: 0, maxInFlight: 0, report: null });
	return runs.get(tag);
};
const now = () => performance.now();

/** `n` requests the server holds, from a page that then does `then` */
const holding = (tag, n, then) => `<script>
const started = [];
for (let i = 0; i < ${n}; i++)
	started.push(fetch('/load?run=${tag}&i=held-' + i + '&d=${HOLD_MS}', { cache: 'no-store', signal: window.held?.signal }).catch(() => {}));
// once the server has every one of them
setTimeout(() => { ${then} }, 500);
</script>`;
/** the page after: six loads at once, then the report on the other host */
const nextPage = (tag, other) => `<!doctype html><title>NEXT</title><script>
Promise.all(Array.from({ length: 6 }, (_, i) =>
	fetch('/load?run=${tag}&i=next-' + i + '&d=${DELAY_MS}', { cache: 'no-store' }).then((r) => r.text()),
)).then(() => fetch(${JSON.stringify(other)} + '/report?run=${tag}', { cache: 'no-store' }));
</script>`;
/** a page whose four requests the server holds, which then navigates to the page after on the same server */
const leavePage = (tag) =>
	`<!doctype html><title>LEAVE</title>${holding(tag, 4, `location.href = '/next.html?run=${tag}';`)}`;
/** a page that aborts six requests the server holds, then loads as the page after does */
const abortPage = (tag, other) =>
	`<!doctype html><title>ABORT</title><script>window.held = new AbortController();</script>${holding(
		tag,
		6,
		`held.abort(); const s = document.createElement('script'); s.src = '/next.js?run=${tag}&other=' + encodeURIComponent(${JSON.stringify(other)}); document.head.append(s);`,
	)}`;
/** a page whose four requests the server holds, left by the harness (a closed tab) */
const closedPage = (tag, other) =>
	`<!doctype html><title>CLOSED</title>${holding(tag, 4, `fetch(${JSON.stringify(other)} + '/report?run=${tag}-left', { cache: 'no-store' });`)}`;

let OTHER = '';
function handler(req, res) {
	const url = new URL(req.url, 'http://x/');
	const q = url.searchParams;
	const tag = q.get('run') ?? '';
	const run = runOf(tag);
	const head = {
		'access-control-allow-origin': '*',
		'cache-control': 'no-store',
	};
	const send = (type, body) => {
		res.writeHead(200, { ...head, 'content-type': type });
		res.end(body);
	};
	if (url.pathname === '/leave.html') return send('text/html', leavePage(tag));
	if (url.pathname === '/abort.html')
		return send('text/html', abortPage(tag, OTHER));
	if (url.pathname === '/closed.html')
		return send('text/html', closedPage(tag, OTHER));
	if (url.pathname === '/next.html')
		return send('text/html', nextPage(tag, OTHER));
	if (url.pathname === '/next.js')
		return send(
			'text/javascript',
			nextPage(tag, q.get('other')).replace(/^.*?<script>|<\/script>$/gs, ''),
		);
	if (url.pathname === '/report') {
		run.report = Object.fromEntries(q);
		res.writeHead(200, head);
		return res.end('ok');
	}
	if (url.pathname !== '/load') {
		res.writeHead(404, head);
		return res.end();
	}
	// the run a page after reports under is the one its held loads were made in
	const load = { i: q.get('i'), at: now(), answered: null };
	run.loads.push(load);
	run.inFlight++;
	run.maxInFlight = Math.max(run.maxInFlight, run.inFlight);
	const timer = setTimeout(
		() => {
			run.inFlight--;
			load.answered = now();
			res.writeHead(200, { ...head, 'content-type': 'text/plain' });
			res.end('');
		},
		+q.get('d') || 0,
	);
	// a request the browser gives up closes its connection: it is in flight
	// no more (the proxy's transport may go on with it, its connection
	// counted free)
	res.on('close', () => {
		if (load.answered !== null) return;
		clearTimeout(timer);
		run.inFlight--;
		load.answered = now();
	});
}

const listen = (server) =>
	new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
	);
const server = createServer({ keepAliveTimeout: 60000 }, handler);
const H1 = `http://127.0.0.1:${await listen(server)}`;
OTHER = H1.replace('127.0.0.1', 'localhost');

/** what of a run is compared: whether the page after went before the held ones were answered */
function after(run) {
	const held = run.loads.filter((load) => load.i.startsWith('held-'));
	const next = run.loads.filter((load) => load.i.startsWith('next-'));
	const firstHeld = Math.min(...held.map((load) => load.at));
	return {
		'held requests that reached the server': held.length,
		'the next loads all reached the server before the held ones were due':
			next.length === 6 &&
			next.every((load) => load.at < firstHeld + HOLD_MS - 1000),
	};
}
/** the most of the next loads in flight at once: fewer than six while held ones of a gone page keep connections */
const nextInFlight = (run) => {
	const next = run.loads.filter((load) => load.i.startsWith('next-'));
	let most = 0;
	for (const load of next)
		most = Math.max(
			most,
			next.filter((other) => other.at <= load.at && other.answered > load.at)
				.length,
		);
	return most;
};

const STEPS = [
	[
		'a page that leaves four requests its server holds for the next page of that server',
		(tag) => [`${H1}/leave.html?run=${tag}`],
		(run) => ({
			...after(run),
			'next loads in flight at once': nextInFlight(run),
		}),
	],
	[
		'six requests the page aborts while its server holds them',
		(tag) => [`${H1}/abort.html?run=${tag}`],
		(run) => ({
			...after(run),
			'next loads in flight at once': nextInFlight(run),
		}),
	],
	[
		'a closed page that leaves four requests its server holds',
		(tag) => [`${H1}/closed.html?run=${tag}`, `${H1}/next.html?run=${tag}`],
		(run) => ({
			...after(run),
			'next loads in flight at once': nextInFlight(run),
		}),
	],
];

const browser = await launch();

/** run every step in `go`'s pages and say what each measured */
async function measure(mode, go) {
	const out = {};
	for (const [name, pages, compare] of STEPS) {
		const tag = `${mode}-${STEPS.findIndex(([n]) => n === name)}`;
		const run = runOf(tag);
		const [first, second] = pages(tag);
		await go(first);
		if (second) {
			const left = runOf(`${tag}-left`);
			for (let i = 0; i < 100 && !left.report; i++) await sleep(100);
			await go(second);
		}
		for (let i = 0; i < 150 && !run.report; i++) await sleep(100);
		out[name] = run.report ? compare(run) : { error: 'no report' };
		// the held ones are answered before the next step
		await sleep(HOLD_MS);
	}
	return out;
}

const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
const native = await measure('native', (url) => nativePage.goto(url));
await nativeContext.close();
console.log('native', JSON.stringify(native));
ok(
	'natively, the page after goes at once',
	Object.values(native).every(
		(step) =>
			step[
				'the next loads all reached the server before the held ones were due'
			] === true,
	),
	JSON.stringify(native),
);

const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
await page.evaluate(async () => {
	const { StompController } = await import('/stomp/controller.mjs');
	const registration = await StompController.register('/stomp/');
	const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
	const controller = new StompController({
		serviceworker: registration,
		transport: { module: '/epoxy/index.mjs', options: [{ wisp }] },
		directory: '/stomp/',
		codec: 'xor',
	});
	await controller.wait();
	window.controller = controller;
});
// each page in a new frame, the one before removed (a tab closed)
const proxied = await measure('proxied', (url) =>
	page.evaluate((url) => {
		document.querySelector('iframe')?.remove();
		const element = document.createElement('iframe');
		element.style.cssText = 'width:800px;height:600px';
		document.body.append(element);
		window.controller.createFrame(element).go(url);
	}, url),
);
console.log('proxied', JSON.stringify(proxied));

for (const [name] of STEPS)
	for (const [field, value] of Object.entries(native[name])) {
		const got = proxied[name]?.[field];
		ok(
			`${name}: ${field}, as natively`,
			JSON.stringify(got) === JSON.stringify(value),
			`native ${JSON.stringify(value)}, proxied ${JSON.stringify(got)}`,
		);
	}

await done(browser, errors);
