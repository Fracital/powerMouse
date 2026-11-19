// The transport comes back by itself when its wisp WebSocket drops while
// nothing is in flight, with only requests to a site it holds a pooled
// connection to after it (no request to a new host beside them, which
// wisp-reconnect always has and which revived the transport on its own).
//
// The browser's drop: Chrome closes the page's WebSockets, the transport
// worker's wisp WebSocket with them, as the page goes into the
// back/forward cache. Epoxy over its own WebSocket (a descriptor without
// `webTransport`: the suites', an embedder's) never ended its wisp
// connection on that close, and the frame's next page, to the same site,
// went to the pooled connection over it and was never answered. The
// controller's `pageshow` tells the transport (RevivingTransport.lost);
// here a listener ahead of the controller's keeps that from it, so what
// is checked is the transport's own: the carrier is handed to epoxy as its
// function transport with `webTransport` off too, and its close ends
// epoxy's wisp connection. Natively, the next page is there in tens of ms
// (bfcache-transport compares).
//
// The network's drops: the wisp WebSocket runs through a TCP relay in this
// script, which resets it, or forgets it as a NAT does an idle flow and
// resets it at the next packet the client sends. With the transport in its
// worker and in the page, a navigation, a page fetch and a raw request to
// the pooled fixture host answer over a new wisp connection, twice each.
import { createServer } from 'node:http';
import net from 'node:net';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const TIMEOUT_MS = 10000;
/** how long the frame's next page may take after Back (natively tens of ms) */
const NEXT_MS = 5000;

const browser = await launch([], { backForwardCache: true });
const errors = [];

// ---- the browser's drop -------------------------------------------------

/** when the server saw each run's next page, by its tag */
const arrived = new Map();
const waiters = new Map();
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const tag = url.searchParams.get('run') ?? '';
	const html = (body) => {
		res.writeHead(200, {
			'content-type': 'text/html',
			'cache-control': 'no-store',
		});
		res.end(body);
	};
	// shown again from the cache, it goes on to the next page of this server
	if (url.pathname === '/frame.html')
		return html(`<!doctype html><title>FRAME</title>
<a id="go" href="/next.html?run=${tag}">next</a>
<script>
addEventListener('pageshow', (event) => {
	if (event.persisted) setTimeout(() => document.getElementById('go').click(), 200);
});
</script>`);
	if (url.pathname === '/next.html') {
		arrived.set(tag, performance.now());
		waiters.get(tag)?.();
		return html('<!doctype html><title>NEXT</title>');
	}
	if (url.pathname === '/away.html')
		return html('<!doctype html><title>AWAY</title>');
	res.writeHead(404);
	res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const SERVER = `http://127.0.0.1:${server.address().port}`;
const AWAY = `http://localhost:${server.address().port}/away.html`;

/** the run's next page within `ms` of `from`: when, or null */
function nextWithin(tag, from, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		const settle = () => {
			clearTimeout(timer);
			resolve(Math.round(arrived.get(tag) - from));
		};
		if (arrived.has(tag)) return settle();
		waiters.set(tag, settle);
	});
}

/** in every frame, before the controller's: no `pageshow` from the cache reaches it */
const unheard = () =>
	addEventListener(
		'pageshow',
		(event) => {
			if (event.persisted) event.stopImmediatePropagation();
		},
		true,
	);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base, {}, (page) =>
		page.addInitScript(unheard),
	);
	page.on('pageerror', (error) => errors.push(error.message));
	const tag = `${mode}-${Date.now()}`;
	await submitLanding(page, `${SERVER}/frame.html?run=${tag}`);
	for (let i = 0; i < 100; i++) {
		const frame = page
			.frames()
			.find((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		if ((await frame?.title().catch(() => '')) === 'FRAME') break;
		await sleep(100);
	}
	await sleep(1000);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Page.enable');
	const reasons = [];
	cdp.on('Page.backForwardCacheNotUsed', (event) =>
		reasons.push(...event.notRestoredExplanations.map((x) => x.reason)),
	);
	await page.goto(AWAY);
	await sleep(500);
	await page.goBack({ waitUntil: 'commit' });
	const ms = await nextWithin(tag, performance.now(), NEXT_MS);
	await cdp.detach().catch(() => {});
	ok(
		`${mode}: the demo comes back from the back/forward cache, its wisp WebSocket closed by Chrome`,
		!reasons.length,
		[...new Set(reasons)].join(' '),
	);
	ok(
		`${mode}: untold, the transport answers the frame's next page to the pooled site within ${NEXT_MS} ms of Back`,
		ms !== null,
		ms === null ? 'none' : `${ms} ms`,
	);
	await page.context().close();
}
server.close();

// ---- the network's drops -------------------------------------------------

// a relay to the demo server that knows which of its sockets carry wisp
const wispSockets = new Set();
let wispConnections = 0;
const relay = net.createServer((client) => {
	const upstream = net.connect(Number(PORT), '127.0.0.1');
	let first = true;
	const pair = [client, upstream];
	client.on('data', (data) => {
		// a flow the NAT forgot: its next packet is answered with a reset
		if (pair.forgotten) {
			client.resetAndDestroy();
			upstream.destroy();
			return;
		}
		if (first) {
			first = false;
			if (data.toString('latin1', 0, 10) === 'GET /wisp/') {
				wispConnections++;
				wispSockets.add(pair);
			}
		}
		upstream.write(data);
	});
	upstream.on('data', (data) => {
		if (!pair.forgotten) client.write(data);
	});
	const end = () => {
		wispSockets.delete(pair);
		client.destroy();
		upstream.destroy();
	};
	for (const socket of pair) {
		socket.on('error', end);
		socket.on('close', end);
	}
});
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const wisp = `ws://127.0.0.1:${relay.address().port}/wisp/`;

/** drop every wisp WebSocket the relay carries: `reset`, or `forget` (a NAT's idle timeout) */
function drop(how) {
	const count = wispSockets.size;
	for (const pair of wispSockets) {
		if (how === 'forget') {
			pair.forgotten = true;
			continue;
		}
		pair[0].resetAndDestroy();
		pair[1].destroy();
	}
	if (how !== 'forget') wispSockets.clear();
	return count;
}

for (const host of ['worker', 'page']) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);

	/** a navigation, a page fetch and a raw request, all to the fixture's host */
	const load = (url, title) =>
		page.evaluate(
			async ({ url, title, timeoutMs }) => {
				const t0 = performance.now();
				const at = (result) =>
					`${result}@${Math.round(performance.now() - t0)}`;
				const hung = new Promise((resolve) =>
					setTimeout(() => resolve('HUNG'), timeoutMs),
				);
				const navigation = window.frame.go(url).then(() => {
					const got = window.element.contentDocument?.title;
					return at(got === title ? 'ok' : `title ${got}`);
				});
				const win = () => window.element.contentWindow;
				const fetched = navigation.then(() =>
					Reflect.apply(win().fetch, win(), [
						`${url.replace(/[^/]*$/, 'echo.json')}?${Date.now()}`,
					]).then((response) =>
						at(response.status === 200 ? 'ok' : `status ${response.status}`),
					),
				);
				const raw = window.controller.transport
					.request(
						new URL(`${url}?raw${Date.now()}`),
						'GET',
						null,
						[],
						undefined,
					)
					.then(async (response) => {
						await new Response(response.body).arrayBuffer();
						return at(
							response.status === 200 ? 'ok' : `status ${response.status}`,
						);
					});
				const settle = (promise) =>
					Promise.race([promise, hung]).catch((error) =>
						String(error).slice(0, 160),
					);
				return {
					navigation: await settle(navigation),
					fetch: await settle(fetched),
					raw: await settle(raw),
				};
			},
			{ url, title, timeoutMs: TIMEOUT_MS },
		);

	await page.evaluate(
		async ({ host, wisp }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: { module: '/epoxy/index.mjs', options: [{ wisp }], host },
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			const element = document.createElement('iframe');
			document.body.append(element);
			Object.assign(window, {
				controller,
				element,
				frame: controller.createFrame(element),
			});
		},
		{ host, wisp },
	);

	const before = await load(`${FIXTURE}pages/walk-1.html`, 'WALK 1');
	ok(
		`${host}: a page, a fetch and a raw request load over the first wisp connection`,
		Object.values(before).every((r) => r.startsWith('ok@')),
		JSON.stringify(before),
	);
	let walk = 1;
	for (const how of ['reset', 'forget', 'reset', 'forget']) {
		// idle: nothing in flight when it goes
		await sleep(300);
		const opened = wispConnections;
		ok(
			`${host}: the relay drops the idle wisp WebSocket (${how})`,
			drop(how) >= 1,
		);
		await sleep(500);
		const n = (walk++ % 3) + 1;
		const after = await load(`${FIXTURE}pages/walk-${n}.html`, `WALK ${n}`);
		ok(
			`${host}: after an idle drop (${how}), a navigation, a page fetch and a raw request to the pooled host answer over a new wisp connection`,
			Object.values(after).every((r) => r.startsWith('ok@')) &&
				wispConnections > opened,
			`${JSON.stringify(after)} ${opened} -> ${wispConnections}`,
		);
	}
	await context.close();
}
relay.close();

await done(browser, errors);
