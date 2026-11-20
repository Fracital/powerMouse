// A body the page reads slower than the wire, from an HTTP/1.1 origin that
// closes an idle keep-alive connection after 1 s, arrives whole, as it does
// natively. Natively TCP's flow control holds the origin back: it is still
// writing while the page reads, and its idle timer starts only near the
// end. Wisp has no flow control toward the client, so through the proxy the
// origin wrote the whole body at once, its connection was idle a second
// later, it closed it, the relay sent the stream's CLOSE, and epoxy dropped
// every packet the stream had received but the page had not read yet: the
// read failed (hyper IncompleteBody) about a second after the origin was
// done (wisp MuxStreamRead ended at the CLOSE before draining its channel;
// deploy/epoxy patch epoxy-tls 0082 reads a CLOSE after the data that came
// before it). Here a page reads 32 MB at 6 MB a second, natively and in a
// proxied frame, and both read every byte; the origin's close times say
// whether it closed while the proxied page was still reading.
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

const MB = 1024 * 1024;
const SIZE = 32 * MB;
/** bytes a second the page reads */
const RATE = 6 * MB;

/** byte i of the body: a pattern a lost or misplaced packet would show */
const block = Buffer.alloc(MB);
for (let i = 0; i < block.length; i++) block[i] = (i * 31 + (i >> 12)) & 255;
/** FNV-1a of the bytes */
function fnv(hash, bytes) {
	for (let i = 0; i < bytes.length; i++)
		hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
	return hash;
}
let digest = 0x811c9dc5;
for (let at = 0; at < SIZE; at += MB) digest = fnv(digest, block);

/** by request id: when the origin wrote the last byte and closed the connection */
const times = new Map();
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>SLOW BODY</title><p>slow body');
		return;
	}
	if (url.pathname !== '/body') return void res.writeHead(404).end();
	const id = url.searchParams.get('id');
	const entry = { started: Date.now() };
	times.set(id, entry);
	res.on('finish', () => (entry.finished = Date.now()));
	req.socket.once('close', () => (entry.closed = Date.now()));
	// no validator and no ranges: nothing STomp could ask for again
	res.writeHead(200, {
		'content-type': 'application/octet-stream',
		'content-length': String(SIZE),
		'cache-control': 'no-store',
	});
	// as fast as the client takes it
	let left = SIZE;
	const more = () => {
		while (left > 0) {
			left -= block.length;
			if (!res.write(block)) return void res.once('drain', more);
		}
		res.end();
	};
	more();
});
// an idle connection is closed after 1 s (node's default is 5 s)
server.keepAliveTimeout = 1000;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in a page: read `url` at `rate` bytes a second, as the origin's bytes */
const readSlowly = async ([url, rate]) => {
	try {
		const response = await fetch(url, { cache: 'no-store' });
		const reader = response.body.getReader();
		let hash = 0x811c9dc5;
		let read = 0;
		const started = performance.now();
		for (;;) {
			const ahead = (read / rate) * 1000 - (performance.now() - started);
			if (ahead > 0) await new Promise((resolve) => setTimeout(resolve, ahead));
			const { done: end, value } = await reader.read();
			if (end) break;
			for (let i = 0; i < value.length; i++)
				hash = Math.imul(hash ^ value[i], 0x01000193) >>> 0;
			read += value.byteLength;
		}
		return {
			status: response.status,
			bytes: read,
			fnv: hash,
			ms: Math.round(performance.now() - started),
		};
	} catch (error) {
		return { error: String(error).slice(0, 200) };
	}
};

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
const native = await nativePage.evaluate(readSlowly, [
	`${ORIGIN}body?id=native`,
	RATE,
]);
await nativePage.close();
ok(
	'natively, a body read slowly from an origin with a 1 s keep-alive arrives whole',
	native.status === 200 && native.bytes === SIZE && native.fnv === digest,
	JSON.stringify(native),
);

const page = await openDemo(browser, PROXY);
await submitLanding(page, `${ORIGIN}page.html`);
let frame = null;
for (let i = 0; i < 120 && !frame; i++) {
	const found = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
	if (
		(await found?.evaluate(() => document.title).catch(() => null)) ===
		'SLOW BODY'
	)
		frame = found;
	else await sleep(250);
}
ok('the proxied page loads', !!frame);
if (frame) {
	const proxied = await Promise.race([
		frame
			.evaluate(readSlowly, [`${ORIGIN}body?id=proxied`, RATE])
			.catch((error) => ({ error: String(error).slice(0, 200) })),
		sleep(60000).then(() => ({ error: 'the read stalled' })),
	]);
	const readEnded = Date.now();
	const { started, finished, closed } = times.get('proxied') ?? {};
	ok(
		'a body read slowly from an origin that closes its idle connection arrives whole, the bytes native Chrome reads',
		proxied.status === native.status &&
			proxied.bytes === native.bytes &&
			proxied.fnv === native.fnv,
		JSON.stringify({
			native,
			proxied,
			// ms after the request reached the origin: when it wrote the last
			// byte, closed the connection, and the proxied read ended
			origin: {
				finished: finished && finished - started,
				closed: closed && closed - started,
				readEnded: started && readEnded - started,
			},
		}),
	);
}

server.close();
server.closeAllConnections();
await done(browser);
