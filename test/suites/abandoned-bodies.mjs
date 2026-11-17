// A response nobody will read is cancelled, as the browser closes the
// connection of a request nobody waits for. The page aborts its fetch
// before the origin's headers came (the abort reaches the service worker as
// a message, never as the fetch event's signal), or the worker answered
// 504 because the headers took longer than its bound: natively the browser
// closes the connection and the origin stops sending. Through the proxy the
// answer that comes later must be cancelled as well, or the transport goes
// on receiving the whole body for nobody (wisp has no flow control towards
// the client: epoxy keeps what a stream receives until it is read), and the
// transport worker's memory grows by every byte of it, for each aborted
// request, until Chrome runs out. Measured on the origin (where its
// connection closed, how much it wrote) and on the transport worker's
// memory (its ArrayBuffers and wasm memory, over CDP). A 200 MB body the
// page reads through the worker leaves the worker's and the transport's
// memory where they were.
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { grewBy, workerMemory } from '../worker-memory.mjs';

const MB = 1024 * 1024;
/** what a late body would send in all */
const LIMIT = 128 * MB;
/** what the origin may have written before the cancel reached it (loopback is fast) */
const SLACK = 48 * MB;
/** what the transport may hold more after the aborts (it held every byte: 4 x LIMIT) */
const KEPT = 24 * MB;

/** what the origin wrote for each /late?id=, and whether it closed early */
const late = new Map();
const chunk = Buffer.alloc(64 * 1024, 120);

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>ABANDONED</title><p>abandoned bodies');
	} else if (url.pathname === '/late' || url.pathname === '/bytes') {
		// the headers after `delay` ms, then `limit` bytes as fast as the
		// connection takes them, until the client goes away
		const delay = Number(url.searchParams.get('delay') || 0);
		const limit = Number(url.searchParams.get('limit'));
		const state = { written: 0, closedEarly: false, finished: false };
		late.set(url.searchParams.get('id'), state);
		let gone = false;
		res.on('close', () => {
			gone = true;
			if (!state.finished) state.closedEarly = true;
		});
		const write = () => {
			while (!gone && state.written < limit) {
				state.written += chunk.length;
				if (!res.write(chunk)) return void res.once('drain', write);
			}
			if (!gone) {
				state.finished = true;
				res.end();
			}
		};
		setTimeout(() => {
			if (gone) return;
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': limit,
				'cache-control': 'no-store',
			});
			write();
		}, delay);
	} else {
		res.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in a page: fetches that are aborted before their headers come */
const abortEarly = async ({ origin, ids, delay, limit }) => {
	const outcomes = await Promise.all(
		ids.map(async (id) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 300);
			try {
				await fetch(`${origin}late?id=${id}&delay=${delay}&limit=${limit}`, {
					signal: controller.signal,
					cache: 'no-store',
				});
				return 'answered';
			} catch (error) {
				return error.name;
			}
		}),
	);
	return outcomes.join(',');
};

/** wait until the origin knows how each of `ids` ended (it closed early, or wrote all) */
async function settled(ids, seconds = 20) {
	for (let i = 0; i < seconds * 4; i++) {
		if (ids.every((id) => late.get(id)?.closedEarly || late.get(id)?.finished))
			break;
		await sleep(250);
	}
	return ids.map((id) => late.get(id) ?? null);
}

const browser = await launch();

const workers = await workerMemory(browser);
const inMB = (bytes) => (bytes === null ? null : Math.round(bytes / MB));

// natively: the aborted requests' connections close, the origin stops
const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
const nativeIds = ['native-0', 'native-1', 'native-2'];
const nativeAborts = await nativePage.evaluate(abortEarly, {
	origin: ORIGIN,
	ids: nativeIds,
	delay: 1500,
	limit: LIMIT,
});
const native = await settled(nativeIds);
await nativePage.close();
ok(
	'natively, a fetch aborted before its headers closes its connection and the origin stops',
	nativeAborts === 'AbortError,AbortError,AbortError' &&
		native.every((state) => state?.closedEarly && state.written < SLACK),
	JSON.stringify({ nativeAborts, native }),
);

const frameOf = async (page) => {
	for (let i = 0; i < 120; i++) {
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
		const title = await frame?.evaluate(() => document.title).catch(() => null);
		if (title === 'ABANDONED') return frame;
		await sleep(250);
	}
	return null;
};

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${ORIGIN}page.html`);
	const frame = await frameOf(page);
	ok(`${mode}: the proxied page loads`, !!frame);
	if (!frame) {
		await page.close();
		continue;
	}

	const ids = [0, 1, 2, 3].map((i) => `${mode}-abort-${i}`);
	const before = await workers.memory();
	const aborts = await frame
		.evaluate(abortEarly, { origin: ORIGIN, ids, delay: 1500, limit: LIMIT })
		.catch((error) => String(error).slice(0, 200));
	const states = await settled(ids);
	// (what the origin wrote last is on its way through the relay)
	await sleep(2000);
	const after = await workers.memory();
	ok(
		`${mode}: a fetch aborted before its headers closes the origin's response once they come, as natively`,
		aborts === 'AbortError,AbortError,AbortError,AbortError' &&
			states.every((state) => state?.closedEarly && state.written < SLACK),
		JSON.stringify({ aborts, states }),
	);
	ok(
		`${mode}: the transport worker does not keep the bodies of aborted fetches`,
		grewBy(before, after, 'transport') !== null &&
			grewBy(before, after, 'transport') < KEPT,
		JSON.stringify({
			grewMB: inMB(grewBy(before, after, 'transport')),
			before,
			after,
		}),
	);

	// 200 MB read whole through the worker: nothing of it stays behind
	const flowBefore = await workers.memory();
	const read = await frame
		.evaluate(
			async (url) => {
				const response = await fetch(url, { cache: 'no-store' });
				const reader = response.body.getReader();
				let bytes = 0;
				for (;;) {
					const { done: end, value } = await reader.read();
					if (end) break;
					bytes += value.byteLength;
				}
				return bytes;
			},
			`${ORIGIN}bytes?id=${mode}-flow&limit=${200 * MB}`,
		)
		.catch((error) => String(error).slice(0, 200));
	const flowAfter = await workers.memory();
	ok(
		`${mode}: a 200 MB body read through the worker leaves the worker's and the transport's memory flat`,
		read === 200 * MB &&
			grewBy(flowBefore, flowAfter, 'sw') !== null &&
			grewBy(flowBefore, flowAfter, 'sw') < 16 * MB &&
			grewBy(flowBefore, flowAfter, 'transport') < 16 * MB,
		JSON.stringify({
			read,
			swMB: inMB(grewBy(flowBefore, flowAfter, 'sw')),
			transportMB: inMB(grewBy(flowBefore, flowAfter, 'transport')),
		}),
	);

	if (mode === 'same-origin') {
		// the worker answers 504 when the headers take longer than its bound
		// (a short bound for the test, through the internal option); the
		// answer that comes after is cancelled
		const timedOut = await page.evaluate(
			async ({ origin, id, limit }) => {
				const controller = new window.StompController({
					serviceworker: window.controller.serviceworker,
					transport: window.controller.transport,
					directory: window.controller.directory.pathname,
					codec: 'xor',
					fetchTimeout: 1000,
				});
				await controller.wait();
				const element = document.createElement('iframe');
				document.body.append(element);
				const loaded = new Promise((resolve) =>
					element.addEventListener('load', resolve, { once: true }),
				);
				await controller.createFrame(element).go(`${origin}page.html`);
				await loaded;
				const status = await element.contentWindow
					.fetch(`${origin}late?id=${id}&delay=2500&limit=${limit}`)
					.then(
						(response) => response.status,
						(error) => String(error),
					);
				return status;
			},
			{ origin: ORIGIN, id: 'timeout', limit: LIMIT },
		);
		const [state] = await settled(['timeout']);
		ok(
			'a response that comes after the worker answered 504 is cancelled',
			timedOut === 504 && state?.closedEarly && state.written < SLACK,
			JSON.stringify({ timedOut, state }),
		);
	}
	await page.close();
}

await workers.detach();
server.close();
server.closeAllConnections();
await done(browser);
