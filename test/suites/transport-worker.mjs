// The worker-hosted transport: a same-origin StompController given a
// TransportDescriptor starts the transport in a dedicated Worker
// (transportWorker.js), so a synchronous XHR that needs the network completes
// instead of spinning to the 30 s limit (it still does with an in-page
// instance, measured first); setTransport(descriptor) swaps epoxy for libcurl
// in the worker; a module that cannot be imported there, or a worker script
// that cannot start, falls back to the page with a `transporthost` event and
// never a dead controller; a page WebSocket is served off-thread too. The
// host page is test/pages/transport-host.html on the fixture origin, the
// bundle the renamed one under /neutral/.
import { done, FIXTURE, launch, ok, PORT } from '../lib.mjs';

const WISP = `ws://127.0.0.1:${PORT}/wisp/`;
// the probe pages are proxied from the fixture's other host name (the proxy
// refuses its own origin, which the host page is on)
const ORIGIN = new URL(FIXTURE).origin.replace('127.0.0.1', 'localhost');
const browser = await launch();
const errors = [];

/** a host page booted the way `params` say; resolves with the page and its boot record */
async function boot(params = {}) {
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	const query = new URLSearchParams({ wisp: WISP, ...params });
	await page.goto(`${FIXTURE}pages/transport-host.html?${query}`);
	await page
		.waitForFunction(() => window.__th?.ready, null, { timeout: 60000 })
		.catch(() => {});
	const record = await page.evaluate(() => window.__th);
	return { page, record };
}
/** run transport-probe.html in a proxied frame of `page` */
const probe = (page, search, timeout = 45000) =>
	page.evaluate(([s, t]) => window.probe(s, t), [search, timeout]);
/** the TypeError (or other outcome) of a setTransport call made in the page */
const swapError = (page, code) =>
	page.evaluate(async (c) => {
		try {
			await window.controller.setTransport(await eval(c));
			return 'resolved';
		} catch (error) {
			return error.constructor.name;
		}
	}, code);

// ---- the in-page instance: today's path, and the deadlock ------------------

{
	const { page, record } = await boot({ transport: 'instance' });
	ok(
		'an instance boots a ready controller hosted in the page',
		record.ready && !record.error && record.host === 'page',
		JSON.stringify(record),
	);
	const sync = await probe(page, 'sync', 60000);
	ok(
		'with an in-page transport a sync XHR to the network spins to the limit (status 0, about 30 s)',
		sync.sync?.status === 0 && sync.sync?.ms >= 25000,
		JSON.stringify(sync.sync),
	);
	const latency = await probe(page, 'latency=50');
	ok(
		'50 sequential fetches through the in-page transport (latency, ms)',
		latency.latency?.n === 50,
		JSON.stringify(latency.latency),
	);
	await page.close();
}

// ---- the descriptor: a worker hosts epoxy -----------------------------------

{
	const { page, record } = await boot();
	ok(
		'a descriptor boots a ready controller with the transport in a worker',
		record.ready &&
			!record.error &&
			record.host === 'worker' &&
			record.events.length === 0,
		JSON.stringify(record),
	);
	const sync = await probe(page, 'sync', 60000);
	ok(
		'a sync XHR to the network completes through the worker-hosted transport',
		sync.sync?.status === 200 && sync.sync?.ms < 10000,
		JSON.stringify(sync.sync),
	);
	const latency = await probe(page, 'latency=50');
	ok(
		'50 sequential fetches through the worker-hosted transport (latency, ms)',
		latency.latency?.n === 50,
		JSON.stringify(latency.latency),
	);
	const ws = await probe(page, 'ws');
	ok(
		'a page WebSocket is served over the worker and the handshake carries the page origin',
		ws.ws?.origin === ORIGIN,
		JSON.stringify(ws.ws),
	);
	const hostRequest = await page.evaluate(async (origin) => {
		try {
			const response = await window.controller.transport.request(
				new URL(`${origin}/pages/echo.json?host`),
				'GET',
				null,
				[],
				undefined,
			);
			return response.status;
		} catch (error) {
			return String(error);
		}
	}, ORIGIN);
	ok(
		'controller.transport reaches the worker-hosted transport from the host page',
		hostRequest === 200,
		String(hostRequest),
	);
	ok(
		'setTransport(instance) on a worker host is a TypeError',
		(await swapError(page, "instantiate(describe('epoxy'))")) === 'TypeError',
	);
	const swapped = await swapError(page, "describe('libcurl')");
	ok(
		'setTransport(descriptor) swaps to libcurl',
		swapped === 'resolved',
		swapped,
	);
	// libcurl answers nothing for a loopback server through wisp (error 52,
	// hosted in the page as well), which every fixture page would now go
	// through: the request after the swap is the host's, to a real site,
	// over the port the worker serves
	const after = await page.evaluate(async () => {
		try {
			const response = await window.controller.transport.request(
				new URL('https://example.com/'),
				'GET',
				null,
				[],
				undefined,
			);
			return response.status;
		} catch (error) {
			return String(error);
		}
	});
	ok(
		'a request after the swap succeeds on libcurl',
		after === 200,
		String(after),
	);
	const hostStill = await page.evaluate(() => window.controller.transportHost);
	ok('transportHost stays worker after a swap', hostStill === 'worker');
	const back = await swapError(page, "describe('epoxy')");
	const again = await probe(page, 'fetch');
	ok(
		'swapping back to epoxy serves the pages again',
		back === 'resolved' && again.fetch?.status === 200,
		JSON.stringify([back, again.fetch]),
	);
	await page.close();
}

// ---- fallback: the module cannot be imported in the worker ----------------

{
	const { page, record } = await boot({ module: '/neutral/missing.mjs' });
	ok(
		'a module that 404s falls back to the page: transportHost page, one transporthost event with the error',
		record.ready &&
			!record.error &&
			record.host === 'page' &&
			record.events.length === 1 &&
			record.events[0].host === 'page' &&
			typeof record.events[0].error === 'string',
		JSON.stringify(record),
	);
	// nothing could be imported anywhere: the document fails at once (the
	// worker's error page) instead of hanging on a transport that never answers
	const failing = await page.evaluate(() => window.load('fetch'));
	ok(
		'a request on the fallen-back controller fails at once instead of hanging',
		failing.ms < 15000 && failing.title !== 'TRANSPORT PROBE',
		JSON.stringify(failing),
	);
	ok(
		'setTransport(descriptor) on a page host is a TypeError',
		(await swapError(page, "describe('epoxy')")) === 'TypeError',
	);
	const swapped = await swapError(page, "instantiate(describe('epoxy'))");
	ok(
		'setTransport(instance) gives the fallen-back controller a transport',
		swapped === 'resolved',
		swapped,
	);
	const working = await probe(page, 'fetch');
	ok(
		'a request then succeeds',
		working.fetch?.status === 200,
		JSON.stringify(working.fetch),
	);
	await page.close();
}

// ---- fallback: the worker script cannot start -----------------------------

{
	const { page, record } = await boot({ worker: 'missing.js' });
	ok(
		'a worker script that 404s falls back to the module imported in the page',
		record.ready &&
			!record.error &&
			record.host === 'page' &&
			record.events.length === 1 &&
			typeof record.events[0].error === 'string',
		JSON.stringify(record),
	);
	const working = await probe(page, 'fetch');
	ok(
		'a request succeeds on the in-page fallback without the host doing anything',
		working.fetch?.status === 200,
		JSON.stringify(working.fetch),
	);
	await page.close();
}

// ---- host: 'page' on the descriptor ----------------------------------------

{
	const { page, record } = await boot({ transport: 'page' });
	ok(
		"a descriptor with host 'page' is imported in the page, no event",
		record.ready &&
			!record.error &&
			record.host === 'page' &&
			record.events.length === 0,
		JSON.stringify(record),
	);
	const working = await probe(page, 'fetch');
	ok(
		'a request succeeds on it',
		working.fetch?.status === 200,
		JSON.stringify(working.fetch),
	);
	await page.close();
}

await done(browser, errors.filter((e) => !/404|missing/.test(e)).slice(0, 5));
