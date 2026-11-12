// What a document's WebRTC costs once it uses it (docs/webrtc-over-wisp.md
// sections 13 and 15), as a gate, as frame-cost is for what every frame
// pays before: the first connection of a document loads the stand-in's
// library (dist/rtcStack.js, a synchronous request, evaluated in the
// bundle's realm), starts the worker (dist/rtcWorker.js), which fetches
// and compiles the stack (rtc.wasm) and makes a certificate; a later
// connection of that document has all of it. Checked against ceilings
// above what this build measures, with room for a loaded runner:
//
// - the sizes of the three files, deterministic;
// - the first createOffer() of a document, timed from the constructor, and
//   the later ones (the median of three), in both demo modes; natively
//   for comparison;
// - the time to fetch each file as the browser saw it, and to compile
//   rtc.wasm in a page of the same browser;
// - the worker's JS heap once it has a connection, and what the renderer
//   that runs it (and the page) grew by.
import { readFileSync, statSync } from 'node:fs';
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

const target = `${FIXTURE}pages/webrtc-peer.html`;
const DIST = new URL('../../dist/', import.meta.url);
const FILES = /\/(rtcStack\.js|rtcWorker\.js|rtc\.wasm)(\?|$)/;

// as built: rtcStack.js 66 KB, rtcWorker.js 82 KB, rtc.wasm 1481 KB; the
// budgets leave room for the media work under way (video).
// Raise one only in the change that needs it, and say why.
// rtcWorker.js went from 110 KB to 128 KB with video: VP8 to simulcast
// (src/rtc/video.ts and its use) take it from 106758 bytes (37079 with
// brotli) to 117940 (40592), 11182 more (3513), on top of Opus FEC and
// comfort noise. Only a document's first use of WebRTC fetches it, once,
// and from the HTTP cache after that; a module of its own for video would
// save those 3.5 KB compressed at the cost of a fetch when a call's first
// video section comes
const SIZE_KB = { 'rtcStack.js': 80, 'rtcWorker.js': 128, 'rtc.wasm': 1700 };
// measured on Chrome 152 and 156 here, at loads of 15 to 50: the first
// offer 55 to 172 ms (natively 3 to 188: Chrome's own first offer starts
// its WebRTC threads), a later one 10 to 60 ms (natively 0.7 to 4), the
// compile 2 to 5 ms (V8 compiles lazily), the worker's heap 680 to 760
// KB, the renderers 23 to 28 MB more. The ceilings leave room for a loaded
// runner
const FIRST_OFFER_MS = Number(process.env.RTC_FIRST_OFFER_MS) || 1500;
const LATER_OFFER_MS = Number(process.env.RTC_LATER_OFFER_MS) || 250;
const COMPILE_MS = Number(process.env.RTC_COMPILE_MS) || 1000;
const WORKER_HEAP_KB = Number(process.env.RTC_WORKER_HEAP_KB) || 2048;
const RENDERER_MB = Number(process.env.RTC_RENDERER_MB) || 64;

for (const [name, budget] of Object.entries(SIZE_KB)) {
	const kb = statSync(new URL(name, DIST)).size / 1024;
	ok(
		`dist/${name} is at most ${budget} KB`,
		kb <= budget,
		`${kb.toFixed(0)} KB`,
	);
}

/** in the page: the first connection of the document, then three more */
const offers = async () => {
	const started = performance.now();
	const first = new RTCPeerConnection();
	const constructed = performance.now();
	first.createDataChannel('cost');
	await first.createOffer();
	const firstOffer = performance.now() - started;
	const later = [];
	for (let i = 0; i < 3; i++) {
		const at = performance.now();
		const pc = new RTCPeerConnection();
		pc.createDataChannel('cost');
		await pc.createOffer();
		later.push(performance.now() - at);
		pc.close();
	}
	later.sort((a, b) => a - b);
	// the first connection stays open: the worker has a connection when
	// its memory is read
	window.__costConnection = first;
	return {
		construct: constructed - started,
		firstOffer,
		later: later[1],
	};
};

const round = (ms) => Math.round(ms * 10) / 10;

/** the renderers' resident memory, KB (Linux /proc) */
async function rendererKB(browser) {
	const session = await browser.newBrowserCDPSession();
	const { processInfo } = await session.send('SystemInfo.getProcessInfo');
	await session.detach();
	let kb = 0;
	for (const info of processInfo)
		if (info.type === 'renderer')
			kb += Number(
				/VmRSS:\s+(\d+)/.exec(
					readFileSync(`/proc/${info.id}/status`, 'utf8'),
				)[1],
			);
	return kb;
}

/**
 * The JS heap of the dedicated worker running `url`, KB, after a garbage
 * collection: through the browser's protocol, attached to the worker's
 * target (messages wrapped, as playwright's session takes no session id)
 */
async function workerHeapKB(browser, url) {
	const session = await browser.newBrowserCDPSession();
	try {
		const { targetInfos } = await session.send('Target.getTargets');
		const worker = targetInfos.find(
			(info) => info.type === 'worker' && url.test(info.url),
		);
		if (!worker) return null;
		const { sessionId } = await session.send('Target.attachToTarget', {
			targetId: worker.targetId,
			flatten: false,
		});
		let next = 1;
		const waiting = new Map();
		session.on('Target.receivedMessageFromTarget', (event) => {
			if (event.sessionId !== sessionId) return;
			const message = JSON.parse(event.message);
			waiting.get(message.id)?.(message.result);
		});
		const send = (method, params = {}) =>
			new Promise((resolve) => {
				const id = next++;
				waiting.set(id, resolve);
				session.send('Target.sendMessageToTarget', {
					sessionId,
					message: JSON.stringify({ id, method, params }),
				});
			});
		await send('HeapProfiler.enable');
		await send('HeapProfiler.collectGarbage');
		const { usedSize } = await send('Runtime.getHeapUsage');
		return usedSize / 1024;
	} finally {
		await session.detach().catch(() => {});
	}
}

const browser = await launch();
const native = await (await browser.newContext()).newPage();
await native.goto(target);
const natively = await native.evaluate(offers);
await native.close();
console.log(
	`note: natively the first offer ${round(natively.firstOffer)} ms, a later one ${round(natively.later)} ms`,
);

for (const [label, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const loads = {};
	page.context().on('requestfinished', (request) => {
		const name = FILES.exec(request.url())?.[1];
		if (!name) return;
		const timing = request.timing();
		loads[name] = round(timing.responseEnd);
	});
	await submitLanding(page, target);
	const frame = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	for (let i = 0; i < 160; i++) {
		if (
			await frame()
				?.evaluate(() => window.__peerReady)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	await sleep(1000);
	const before = await rendererKB(browser);
	const cost = await frame()
		.evaluate(offers)
		.catch((error) => ({ failure: String(error).slice(0, 300) }));
	await sleep(1000);
	const grown = (await rendererKB(browser)) - before;
	const heap = await workerHeapKB(browser, /\/rtcWorker\.js/);
	ok(
		`${label}: a document's first createOffer() resolves within ${FIRST_OFFER_MS} ms of its first RTCPeerConnection, a later one within ${LATER_OFFER_MS} ms`,
		!cost.failure &&
			cost.firstOffer <= FIRST_OFFER_MS &&
			cost.later <= LATER_OFFER_MS,
		cost.failure ??
			`first ${round(cost.firstOffer)} ms (the constructor ${round(cost.construct)}), later ${round(cost.later)} ms; natively ${round(natively.firstOffer)} and ${round(natively.later)} ms`,
	);
	ok(
		`${label}: the library, the worker and the stack are each fetched once, when the first connection is made`,
		Object.keys(loads).sort().join() === 'rtc.wasm,rtcStack.js,rtcWorker.js',
		JSON.stringify(loads),
	);
	ok(
		`${label}: the worker's heap with a connection is at most ${WORKER_HEAP_KB} KB, and the renderer grew by at most ${RENDERER_MB} MB`,
		heap !== null && heap <= WORKER_HEAP_KB && grown / 1024 <= RENDERER_MB,
		`worker heap ${heap === null ? 'not found' : `${heap.toFixed(0)} KB`}, renderer +${(grown / 1024).toFixed(1)} MB`,
	);
	console.log(
		`note: ${label}: fetched in (ms, as the browser saw it) ${JSON.stringify(loads)}`,
	);
	if (label === 'same-origin') {
		// the stack's compile, alone, in the host page of the same browser
		const compile = await page.evaluate(async () => {
			const bytes = await (await fetch('/stomp/rtc.wasm')).arrayBuffer();
			const at = performance.now();
			await WebAssembly.compile(bytes);
			return performance.now() - at;
		});
		ok(
			`rtc.wasm compiles in at most ${COMPILE_MS} ms`,
			compile <= COMPILE_MS,
			`${round(compile)} ms`,
		);
	}
	await frame()
		.evaluate(() => window.__costConnection?.close())
		.catch(() => {});
	await page.close();
}

await done(browser);
