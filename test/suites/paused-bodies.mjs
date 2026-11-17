// A large body the page stops reading, or reads slower than the wire, does
// not pile up in the transport. Natively such a reader holds the origin
// back (the browser stops reading the socket); through the proxy wisp has
// no flow control towards the client, so epoxy received the whole body at
// the wire's speed and kept it in the transport worker's wasm memory, which
// never shrinks (a 300 MB video a media element read 25 MB of was all there
// within 20 s). A resumable body (ranges, a strong validator, a length, no
// content coding) is now let go when the reader falls behind and asked for
// again by range as it catches up (src/transport/resumableBody.ts). Here a
// page reads a 192 MB body from an origin that sends 16 MB a second, twice:
// 8 MB then a 10 s pause, and 4 MB a second for 12 s (small steps, never a
// pause); then it reads the rest. The bytes are the ones native Chrome
// reads, the transport worker's memory stays bounded, and the origin was
// asked for the rest by range, a few times, not at every step. A body that
// cannot be resumed (no validator) still arrives whole after a pause.
import { createServer } from 'node:http';
import {
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { grewBy, workerMemory } from '../worker-memory.mjs';

const MB = 1024 * 1024;
const SIZE = 192 * MB;
/** bytes a second the origin sends, about a fast home connection */
const RATE = 16 * MB;
const PAUSE_S = 10;

/** byte i of the body: a pattern a misplaced range would show */
const block = Buffer.alloc(MB);
for (let i = 0; i < block.length; i++) block[i] = (i * 31 + (i >> 12)) & 255;
const bodyRange = (from, to) => {
	const out = Buffer.alloc(to - from + 1);
	for (let at = from; at <= to;) {
		const offset = at % MB;
		const n = Math.min(MB - offset, to - at + 1);
		block.copy(out, at - from, offset, offset + n);
		at += n;
	}
	return out;
};
/** FNV-1a of the bytes (the page reads 192 MB: no copy of it is kept to hash) */
function fnv(hash, bytes) {
	for (let i = 0; i < bytes.length; i++)
		hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
	return hash;
}
let digest = 0x811c9dc5;
for (let at = 0; at < SIZE; at += MB)
	digest = fnv(digest, bodyRange(at, Math.min(SIZE, at + MB) - 1));

/** the Range header of each request for /body, by id */
const asked = new Map();

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>PAUSED</title><p>paused bodies');
		return;
	}
	if (url.pathname !== '/body') return void res.writeHead(404).end();
	const id = url.searchParams.get('id');
	const validated = url.searchParams.get('validated') === '1';
	asked.set(id, [...(asked.get(id) ?? []), req.headers.range ?? null]);
	const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
	const ifRange = req.headers['if-range'];
	const usable = range && validated && (!ifRange || ifRange === '"v1"');
	const from = usable ? Number(range[1]) : 0;
	const to = usable && range[2] ? Number(range[2]) : SIZE - 1;
	const headers = {
		'content-type': 'application/octet-stream',
		'content-length': to - from + 1,
		'cache-control': 'no-store',
	};
	if (validated) {
		headers['accept-ranges'] = 'bytes';
		headers.etag = '"v1"';
	}
	if (usable) headers['content-range'] = `bytes ${from}-${to}/${SIZE}`;
	res.writeHead(usable ? 206 : 200, headers);
	// RATE bytes a second, in 256 KB steps
	let at = from;
	let gone = false;
	res.on('close', () => (gone = true));
	const step = RATE / 64;
	const send = () => {
		if (gone) return;
		if (at > to) return void res.end();
		const end = Math.min(to, at + step - 1);
		const ready = res.write(bodyRange(at, end));
		at = end + 1;
		if (ready) setTimeout(send, 1000 / 64);
		else res.once('drain', () => setTimeout(send, 1000 / 64));
	};
	send();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in a page: start reading `url`, 8 MB, then wait for window.__readOn */
const start = (url) => {
	let resolvePause;
	window.__pause = new Promise((resolve) => (resolvePause = resolve));
	window.__paused = (async () => {
		const response = await fetch(url, { cache: 'no-store' });
		const reader = response.body.getReader();
		let hash = 0x811c9dc5;
		let read = 0;
		for (;;) {
			if (read >= 8 * 1024 * 1024 && resolvePause) {
				resolvePause(read);
				resolvePause = null;
				await new Promise((resolve) => (window.__readOn = resolve));
			}
			const { done: end, value } = await reader.read();
			if (end) break;
			for (let i = 0; i < value.length; i++)
				hash = Math.imul(hash ^ value[i], 0x01000193) >>> 0;
			read += value.byteLength;
		}
		return { status: response.status, bytes: read, fnv: hash };
	})().catch((error) => {
		resolvePause?.(null);
		return { error: String(error) };
	});
	return window.__pause;
};
/** in a page: read `url` at 4 MB a second for 12 s, then wait for window.__readOn */
const startSlow = (url) => {
	let resolveSlow;
	window.__pause = new Promise((resolve) => (resolveSlow = resolve));
	window.__paused = (async () => {
		const response = await fetch(url, { cache: 'no-store' });
		const reader = response.body.getReader();
		let hash = 0x811c9dc5;
		let read = 0;
		const started = performance.now();
		for (;;) {
			const elapsed = performance.now() - started;
			if (resolveSlow && elapsed > 12000) {
				resolveSlow(read);
				resolveSlow = null;
				await new Promise((resolve) => (window.__readOn = resolve));
			} else if (resolveSlow) {
				const ahead = (read / (4 * 1024 * 1024)) * 1000 - elapsed;
				if (ahead > 0)
					await new Promise((resolve) => setTimeout(resolve, ahead));
			}
			const { done: end, value } = await reader.read();
			if (end) break;
			for (let i = 0; i < value.length; i++)
				hash = Math.imul(hash ^ value[i], 0x01000193) >>> 0;
			read += value.byteLength;
		}
		return { status: response.status, bytes: read, fnv: hash };
	})().catch((error) => {
		resolveSlow?.(null);
		return { error: String(error) };
	});
	return window.__pause;
};
const finish = async () => {
	window.__readOn();
	return window.__paused;
};

const browser = await launch();

// natively: the same reads, the same bytes
const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
await nativePage.evaluate(start, `${ORIGIN}body?id=native&validated=1`);
await sleep(PAUSE_S * 1000);
const native = await nativePage.evaluate(finish);
await nativePage.close();
ok(
	'natively, a body read after a pause arrives whole',
	native.status === 200 && native.bytes === SIZE && native.fnv === digest,
	JSON.stringify(native),
);

const workers = await workerMemory(browser);
const page = await openDemo(browser, PROXY);
await submitLanding(page, `${ORIGIN}page.html`);
let frame = null;
for (let i = 0; i < 120 && !frame; i++) {
	const found = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
	if (
		(await found?.evaluate(() => document.title).catch(() => null)) === 'PAUSED'
	)
		frame = found;
	else await sleep(250);
}
ok('the proxied page loads', !!frame);
if (frame) {
	const before = await workers.memory();
	await frame.evaluate(start, `${ORIGIN}body?id=resumable&validated=1`);
	await sleep(PAUSE_S * 1000);
	const paused = await workers.memory();
	const proxied = await frame
		.evaluate(finish)
		.catch((error) => ({ error: String(error).slice(0, 200) }));
	ok(
		'a body read after a pause arrives whole, the bytes native Chrome reads',
		proxied.status === native.status &&
			proxied.bytes === native.bytes &&
			proxied.fnv === native.fnv,
		JSON.stringify({ native, proxied }),
	);
	ok(
		'the transport worker does not keep what the origin sent while the page paused',
		grewBy(before, paused, 'transport') !== null &&
			grewBy(before, paused, 'transport') < 64 * MB,
		JSON.stringify({
			grewMB: Math.round((grewBy(before, paused, 'transport') ?? 0) / MB),
			before: before.transport,
			paused: paused.transport,
		}),
	);
	const ranges = asked.get('resumable') ?? [];
	ok(
		'the rest was asked for by range, from where the page was',
		ranges.length >= 2 &&
			ranges[0] === null &&
			ranges.slice(1).every((range) => /^bytes=\d+-\d+$/.test(range)),
		JSON.stringify(ranges),
	);

	// slower than the wire, never pausing: the transport stays bounded
	// and the origin is asked again once per ~12 MB the reader falls behind
	const slowRead = await Promise.race([
		frame.evaluate(startSlow, `${ORIGIN}body?id=slow&validated=1`),
		sleep(60000).then(() => 'stalled'),
	]);
	const slowMemory = await workers.memory();
	const slow =
		slowRead === 'stalled'
			? { error: 'the slow read stalled' }
			: await Promise.race([
					frame.evaluate(finish),
					sleep(120000).then(() => ({ error: 'the rest stalled' })),
				]).catch((error) => ({ error: String(error).slice(0, 200) }));
	ok(
		'a body read slower than the wire arrives whole, the bytes native Chrome reads',
		slow.status === native.status &&
			slow.bytes === native.bytes &&
			slow.fnv === native.fnv,
		JSON.stringify({ native, slow }),
	);
	// against the memory before the first read: a wasm memory never
	// shrinks, so what the first body left would hide what this one queued
	const slowGrew = grewBy(before, slowMemory, 'transport');
	ok(
		'the transport worker does not keep what the origin sent ahead of a slow reader',
		slowGrew !== null && slowGrew < 64 * MB,
		JSON.stringify({
			grewMB: Math.round((slowGrew ?? 0) / MB),
			before: before.transport,
			slow: slowMemory.transport,
		}),
	);
	const slowRanges = asked.get('slow') ?? [];
	ok(
		'a slow reader is asked for again a few times, not at every step',
		slowRanges.length >= 2 &&
			slowRanges.length <= 12 &&
			slowRanges[0] === null &&
			slowRanges.slice(1).every((range) => /^bytes=\d+-\d+$/.test(range)),
		JSON.stringify(slowRanges),
	);

	// no validator: nothing to resume against, so it is received as before
	await frame.evaluate(start, `${ORIGIN}body?id=plain`);
	await sleep(3000);
	const plain = await frame
		.evaluate(finish)
		.catch((error) => ({ error: String(error).slice(0, 200) }));
	ok(
		'a body that cannot be resumed arrives whole after a pause',
		plain.bytes === SIZE &&
			plain.fnv === digest &&
			(asked.get('plain') ?? []).length === 1,
		JSON.stringify({ plain, asked: asked.get('plain') }),
	);
}

await workers.detach();
server.close();
server.closeAllConnections();
await done(browser);
