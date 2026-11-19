// The carrier host (src/transport/carrierHost.ts): the origin's wisp
// connection to the relay lives in a SharedWorker that outlives the page,
// and every transport of the origin rides it, its own stream ids mapped
// onto the relay connection's. Through test/wisp-wt.mjs (holyWisp's
// design: one Wisp stream per session) in front of the demo's holyWisp,
// with the transport in its worker and in the page:
//  - a reload and a second tab ride the session the first start opened:
//    no session, no WebSocket and no document of their own, the
//    controller's `carrier` saying how long it had been up; a navigation,
//    a page's fetch and the host's own request answer in both tabs at once;
//  - with Wisp v2, the second tab is played the relay's INFO and its
//    CONTINUE as the first heard them, and answers over the same session;
//  - the tab that closes is let go (its streams closed on the relay) and
//    the one that stays answers, before and after the host notices;
//  - the relay restarting (every session closed) leaves the riders to a
//    new session the host opens, and the next requests answer over it;
//  - the host ending under the pages (a crash): their transports find it
//    gone, end its riders and answer over carriers of their own, and a new
//    tab starts a new host;
//  - with WebTransport off, the tabs share the one WebSocket.
import { done, FIXTURE, launch, ok, PORT, PROXY, sleep } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';

const TIMEOUT_MS = 10000;
/** the carrier's timeout here, short so a fallback would be quick */
const CARRIER_MS = 1500;
/** carrierClient.ts GONE_MS: a page not heard from for this long is gone */
const GONE_MS = 8000;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const browser = await launch();
const errors = [];

/** starts a controller in `page` at the relay, `webTransport` on unless `wt` is false */
function startController(page, host, { wt = true, v2 = false } = {}) {
	return page.evaluate(
		async ({ host, wisp, wt, v2, carrierMs }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					options: [{ wisp, ...(v2 && { wisp_v2: true }) }],
					host,
					...(wt && { webTransport: { timeoutMs: carrierMs } }),
				},
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
		{ host, wisp: relay.wisp, wt, v2, carrierMs: CARRIER_MS },
	);
}

/** a controller page of `context`, started */
async function open(context, host, options) {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await startController(page, host, options);
	return page;
}

/** the controller's `carrier` once the transport chose */
const carrierInfo = (page) =>
	page.evaluate(async () => {
		for (let i = 0; i < 60 && !window.controller.carrier; i++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		return window.controller.carrier;
	});

/** a navigation, a page's fetch and the host's own request, each "ok@ms" or why not */
function load(page, n) {
	const url = `${FIXTURE}pages/walk-${n}.html`;
	return page.evaluate(
		async ({ url, title, timeoutMs }) => {
			const t0 = performance.now();
			const at = (result) => `${result}@${Math.round(performance.now() - t0)}`;
			const hung = new Promise((resolve) =>
				setTimeout(() => resolve('HUNG'), timeoutMs),
			);
			const settle = (promise) =>
				Promise.race([promise, hung]).catch((error) =>
					String(error).slice(0, 200),
				);
			const navigation = window.frame.go(url).then(() => {
				const got = window.element.contentDocument?.title;
				return at(got === title ? 'ok' : `title ${got}`);
			});
			const win = () => window.element.contentWindow;
			const fetched = navigation.then(() =>
				Reflect.apply(win().fetch, win(), [
					`${url.replace(/[^/]*$/, 'echo.json')}?${Date.now()}`,
				]).then((r) => at(r.status === 200 ? 'ok' : `status ${r.status}`)),
			);
			const raw = window.controller.transport
				.request(new URL(`${url}?raw${Date.now()}`), 'GET', null, [], undefined)
				.then(async (r) => {
					await new Response(r.body).arrayBuffer();
					return at(r.status === 200 ? 'ok' : `status ${r.status}`);
				});
			return {
				navigation: await settle(navigation),
				fetch: await settle(fetched),
				raw: await settle(raw),
			};
		},
		{ url, title: `WALK ${n}`, timeoutMs: TIMEOUT_MS },
	);
}
const allOk = (...results) =>
	results.every((result) =>
		Object.values(result).every((r) => r.startsWith('ok@')),
	);

const snapshot = () => ({ ...relay.stats });
const delta = (before) =>
	Object.fromEntries(
		['documents', 'sessions', 'sessionsClosed', 'ws'].map((k) => [
			k,
			relay.stats[k] - before[k],
		]),
	);
/** ends every carrier host's SharedWorker (CDP), as a crash would: how many */
async function endHosts() {
	const cdp = await browser.newBrowserCDPSession();
	const { targetInfos } = await cdp.send('Target.getTargets');
	let ended = 0;
	for (const target of targetInfos)
		if (target.type === 'shared_worker') {
			await cdp
				.send('Target.closeTarget', { targetId: target.targetId })
				.then(() => ended++)
				.catch(() => {});
		}
	await cdp.detach();
	return ended;
}

/** shared: the carrier the host had up already (CarrierInfo.shared, ms) */
const rode = (info, carrier) =>
	info?.carrier === carrier &&
	typeof info.shared === 'number' &&
	info.shared > 0;

for (const host of ['worker', 'page']) {
	// a reload and a second tab
	{
		const context = await browser.newContext();
		let before = snapshot();
		const first = await open(context, host);
		const one = await load(first, 1);
		const info = await carrierInfo(first);
		const d = delta(before);
		ok(
			`${host}: the first start opens a session and rides it`,
			allOk(one) &&
				info?.carrier === 'webtransport' &&
				!info.shared &&
				d.sessions === 1,
			JSON.stringify({ one, info, d }),
		);

		before = snapshot();
		await first.goto(`${PROXY}stomp/controllerFrame.html`);
		await startController(first, host);
		const reloaded = await load(first, 2);
		const again = await carrierInfo(first);
		const d2 = delta(before);
		ok(
			`${host}: a reload rides the session up already, no session, WebSocket or document of its own`,
			allOk(reloaded) &&
				rode(again, 'webtransport') &&
				d2.sessions === 0 &&
				d2.ws === 0 &&
				d2.documents === 0,
			JSON.stringify({ reloaded, again, d2 }),
		);

		before = snapshot();
		const second = await open(context, host);
		const tab = await load(second, 3);
		const tabInfo = await carrierInfo(second);
		const d3 = delta(before);
		ok(
			`${host}: a second tab rides it too`,
			allOk(tab) &&
				rode(tabInfo, 'webtransport') &&
				d3.sessions === 0 &&
				d3.ws === 0,
			JSON.stringify({ tab, tabInfo, d3 }),
		);

		const [a, b] = await Promise.all([load(first, 4), load(second, 5)]);
		ok(
			`${host}: both tabs answer at once over the one session`,
			allOk(a, b) && delta(before).sessions === 0,
			JSON.stringify({ a, b }),
		);

		await second.close();
		const kept = await load(first, 1);
		await sleep(GONE_MS + 2 * 2000);
		const later = await load(first, 2);
		ok(
			`${host}: the tab that stays answers once the other closed, before and after the host lets it go`,
			allOk(kept, later) && delta(before).sessions === 0,
			JSON.stringify({ kept, later }),
		);

		before = snapshot();
		relay.cut();
		await sleep(300);
		const cut = await load(first, 3);
		const d4 = delta(before);
		ok(
			`${host}: the relay restarting leaves the riders to a new session, and the next requests answer over it`,
			allOk(cut) && d4.sessions === 1,
			JSON.stringify({ cut, d4 }),
		);

		// the host itself goes (its worker ended under the page)
		const ended = await endHosts();
		await sleep(GONE_MS + 3 * 2000);
		before = snapshot();
		const orphaned = await load(first, 4);
		const d5 = delta(before);
		ok(
			`${host}: the host gone, the page's next requests answer over a carrier of its own`,
			ended >= 1 && allOk(orphaned) && d5.sessions + d5.ws >= 1,
			JSON.stringify({ ended, orphaned, d5 }),
		);
		const third = await open(context, host);
		const fresh = await load(third, 5);
		ok(
			`${host}: and a new tab starts a new host, and answers`,
			allOk(fresh),
			JSON.stringify({ fresh, info: await carrierInfo(third) }),
		);
		await context.close();
	}

	// Wisp v2: the second rider is played the relay's INFO and CONTINUE
	{
		const context = await browser.newContext();
		const first = await open(context, host, { v2: true });
		const one = await load(first, 1);
		const before = snapshot();
		const second = await open(context, host, { v2: true });
		const [a, b] = await Promise.all([load(first, 2), load(second, 3)]);
		const info = await carrierInfo(second);
		ok(
			`${host} v2: a second tab rides the session with Wisp v2, both answering`,
			allOk(one, a, b) &&
				rode(info, 'webtransport') &&
				delta(before).sessions === 0 &&
				relay.stats.protocols.includes('wisp-v2'),
			JSON.stringify({ one, a, b, info, protocols: relay.stats.protocols }),
		);
		await context.close();
	}

	// WebTransport off: the WebSocket is shared
	{
		const context = await browser.newContext();
		const before = snapshot();
		const first = await open(context, host, { wt: false });
		const one = await load(first, 1);
		const second = await open(context, host, { wt: false });
		const two = await load(second, 2);
		const info = await carrierInfo(second);
		const d = delta(before);
		ok(
			`${host} WebTransport off: a second tab rides the first one's WebSocket`,
			allOk(one, two) &&
				rode(info, 'websocket') &&
				d.ws === 1 &&
				d.sessions === 0,
			JSON.stringify({ one, two, info, d }),
		);
		await context.close();
	}
}

await done(browser, errors);
