// The transport comes back after its wisp connection is lost. Epoxy keeps a
// dead wisp multiplexor as its connection for good (a write that failed on
// the dead socket leaves the multiplexor's write lock taken, so its task
// never finishes), and before RevivingTransport every request after a drop
// failed at once with MuxTaskEnded until the host page was reloaded: a port
// forward that dropped the WebSocket 1.5 s into a YouTube load left the page
// half drawn. Here the wisp WebSocket runs through a TCP relay in this
// script that can cut it; after the cut, with the transport in its worker
// and in the page, a frame navigates, a page fetches and the host requests
// through the transport, and all of it must answer on a new wisp connection.
import net from 'node:net';
import { done, FIXTURE, launch, ok, PORT, PROXY } from '../lib.mjs';

const TIMEOUT_MS = 10000;

// a relay to the demo server that knows which of its sockets carry wisp
const wispSockets = new Set();
let wispConnections = 0;
const relay = net.createServer((client) => {
	const upstream = net.connect(Number(PORT), '127.0.0.1');
	let first = true;
	const pair = [client, upstream];
	client.on('data', (data) => {
		if (first) {
			first = false;
			if (data.toString('latin1', 0, 10) === 'GET /wisp/') {
				wispConnections++;
				wispSockets.add(pair);
			}
		}
		upstream.write(data);
	});
	upstream.on('data', (data) => client.write(data));
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

/** drop every wisp WebSocket the relay carries, as a port forward might */
function cut() {
	const count = wispSockets.size;
	for (const [client, upstream] of wispSockets) {
		client.destroy();
		upstream.destroy();
	}
	wispSockets.clear();
	return count;
}

const browser = await launch();
const errors = [];

for (const host of ['worker', 'page']) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);

	const load = (url, title) =>
		page.evaluate(
			async ({ url, title, timeoutMs, otherUrl }) => {
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
				// a request that needs a new connection, beside the fixture's
				// pooled one
				const other = window.controller.transport
					.request(new URL(otherUrl), 'GET', null, [], undefined)
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
					other: await settle(other),
				};
			},
			{
				url,
				title,
				timeoutMs: TIMEOUT_MS,
				otherUrl: `http://localhost:${PORT}/config.js?${Date.now()}`,
			},
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
			// the host's own requests go straight to the transport (in the page,
			// the transport itself), which serveTransport would have started
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
	// requests waiting for their answers when the connection goes, as in a
	// page load: the host's own and a page's fetches
	await page.evaluate(
		({ fixture, timeoutMs }) => {
			const t0 = performance.now();
			const hung = new Promise((resolve) =>
				setTimeout(() => resolve('HUNG'), timeoutMs),
			);
			const slow = (i) => `${fixture}slow-js?ms=1500&i=${i}-${Date.now()}`;
			const answer = (promise) =>
				Promise.race([
					promise.then(async (response) => {
						await new Response(response.body).text();
						return `${response.status === 200 ? 'ok' : `status ${response.status}`}@${Math.round(performance.now() - t0)}`;
					}),
					hung,
				]).catch((error) => String(error).slice(0, 160));
			const win = window.element.contentWindow;
			window.inFlight = Promise.all([
				...[0, 1, 2].map((i) =>
					answer(
						window.controller.transport.request(
							new URL(slow(`raw${i}`)),
							'GET',
							null,
							[],
							undefined,
						),
					),
				),
				...[0, 1, 2].map((i) =>
					answer(Reflect.apply(win.fetch, win, [slow(`page${i}`)])),
				),
			]);
		},
		{ fixture: FIXTURE, timeoutMs: TIMEOUT_MS },
	);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const openedInFlight = wispConnections;
	ok(
		`${host}: the relay cut the wisp connection under requests in flight`,
		cut() >= 1,
	);
	const inFlight = await page.evaluate(() => window.inFlight);
	ok(
		`${host}: GETs in flight when the wisp connection was lost all answer`,
		inFlight.every((r) => r.startsWith('ok@')),
		JSON.stringify(inFlight),
	);
	ok(
		`${host}: they answered over a new wisp connection`,
		wispConnections > openedInFlight,
		`${openedInFlight} -> ${wispConnections}`,
	);

	const opened = wispConnections;
	const dropped = cut();
	ok(`${host}: the relay cut the wisp connection`, dropped >= 1, `${dropped}`);
	// let the transport see the socket go
	await new Promise((resolve) => setTimeout(resolve, 500));
	const after = await load(`${FIXTURE}pages/walk-2.html`, 'WALK 2');
	ok(
		`${host}: after the wisp connection was lost, a navigation, a page fetch and a raw request all answer`,
		Object.values(after).every((r) => r.startsWith('ok@')),
		JSON.stringify(after),
	);
	ok(
		`${host}: they answered over a new wisp connection`,
		wispConnections > opened,
		`${opened} -> ${wispConnections}`,
	);
	const again = await load(`${FIXTURE}pages/walk-3.html`, 'WALK 3');
	ok(
		`${host}: the new connection keeps serving`,
		Object.values(again).every((r) => r.startsWith('ok@')),
		JSON.stringify(again),
	);
	await context.close();
}

relay.close();
await done(browser, errors);
