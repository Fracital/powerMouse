// A 12 MB body arrives byte for byte, plain and pre-compressed (gzip, br),
// through the transport and through the service worker. The body crosses
// from the transport to the worker on a port of its own, pushed in batches
// with a bounded window (src/transport/bodyPort.ts), where a transferred
// stream moved one 16 KiB chunk per round trip between the threads. The
// page sees the origin's Content-Encoding and Content-Length with the
// decoded body, as natively (the transport decodes once; the worker's
// Response is not decoded again). A page that cancels the body stops the
// origin's response, and a body the page leaves unread for a while flows
// again when it reads. The bodies come from a server this suite runs
// itself, so it can watch what the origin wrote.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
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

const SIZE = 12 * 1000 * 1000;

/** a script-like body that compresses about as well as a real bundle (3 to 4x) */
function bundle(size) {
	let seed = 0x2f6b1a3d;
	const random = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 4294967296;
	};
	const words = Array.from({ length: 4000 }, () =>
		Math.floor(random() * 36 ** 6).toString(36),
	);
	const parts = [];
	let length = 0;
	while (length < size) {
		const line = `e.${words[Math.floor(random() * words.length)]}=function(${words[Math.floor(random() * 64)]}){return ${Math.floor(random() * 1e6)}+"${words[Math.floor(random() * words.length)]}"};\n`;
		parts.push(line);
		length += line.length;
	}
	return Buffer.from(parts.join('')).subarray(0, size);
}

const plain = bundle(SIZE);
const variants = {
	identity: plain,
	gzip: gzipSync(plain, { level: 6 }),
	br: brotliCompressSync(plain, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
	}),
};
const digest = createHash('sha256').update(plain).digest('hex');

/** what the origin wrote for each /endless?id=, and whether its socket closed */
const endless = new Map();

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>LARGE BODY</title><p>large body</p>');
	} else if (url.pathname === '/big.js') {
		const encoding = url.searchParams.get('enc') || 'identity';
		const body = variants[encoding];
		const headers = {
			'content-type': 'text/javascript',
			'content-length': body.length,
			'cache-control': 'no-store',
		};
		if (encoding !== 'identity') headers['content-encoding'] = encoding;
		res.writeHead(200, headers);
		res.end(body);
	} else if (url.pathname === '/endless') {
		// as fast as the connection takes it, until the client goes away or
		// `limit` bytes went out
		const limit = Number(url.searchParams.get('limit'));
		const state = { written: 0, closed: false };
		endless.set(url.searchParams.get('id'), state);
		res.writeHead(200, {
			'content-type': 'application/octet-stream',
			'cache-control': 'no-store',
		});
		const chunk = Buffer.alloc(64 * 1024, 120);
		const write = () => {
			while (!state.closed && state.written < limit) {
				state.written += chunk.length;
				if (!res.write(chunk)) return void res.once('drain', write);
			}
			if (!state.closed) res.end();
		};
		res.on('close', () => (state.closed = true));
		write();
	} else if (url.pathname === '/truncated') {
		// says 4 MB, sends 1 MB and drops the connection
		res.writeHead(200, {
			'content-type': 'application/octet-stream',
			'content-length': 4 * 1024 * 1024,
			'cache-control': 'no-store',
		});
		res.write(Buffer.alloc(1024 * 1024, 121), () =>
			setTimeout(() => res.destroy(), 200),
		);
	} else {
		res.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in a page: the body's length, SHA-256, Content-Encoding and Content-Length */
const readAll = async (url) => {
	const response = await fetch(url, { cache: 'no-store' });
	const buffer = await response.arrayBuffer();
	const hash = await crypto.subtle.digest('SHA-256', buffer);
	return {
		status: response.status,
		bytes: buffer.byteLength,
		sha256: [...new Uint8Array(hash)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join(''),
		encoding: response.headers.get('content-encoding'),
		length: response.headers.get('content-length'),
	};
};

/** in a page: how reading a body the origin cut short ends */
const readCut = async (url) => {
	const response = await fetch(url, { cache: 'no-store' });
	try {
		const buffer = await response.arrayBuffer();
		return `resolved ${buffer.byteLength}`;
	} catch (error) {
		return `rejected ${error.name}`;
	}
};

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
const native = {};
for (const encoding of Object.keys(variants))
	native[encoding] = await nativePage.evaluate(
		readAll,
		`${ORIGIN}big.js?enc=${encoding}`,
	);
native.truncated = await nativePage.evaluate(readCut, `${ORIGIN}truncated`);
await nativePage.close();
ok(
	'natively, every variant decodes to the same 12 MB with the origin encoding and length',
	Object.entries(native).every(
		([encoding, result]) =>
			encoding === 'truncated' ||
			(result.sha256 === digest &&
				result.encoding === (encoding === 'identity' ? null : encoding) &&
				Number(result.length) === variants[encoding].length),
	),
	JSON.stringify(native),
);

const frameOf = async (page) => {
	for (let i = 0; i < 120; i++) {
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
		const title = await frame?.evaluate(() => document.title).catch(() => null);
		if (title === 'LARGE BODY') return frame;
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
	for (const encoding of Object.keys(variants)) {
		const proxied = await frame
			.evaluate(readAll, `${ORIGIN}big.js?enc=${encoding}`)
			.catch((error) => ({ error: String(error).slice(0, 200) }));
		ok(
			`${mode}: ${encoding}: the page reads the same 12 MB with the same Content-Encoding and Content-Length as natively`,
			proxied.status === 200 &&
				proxied.sha256 === native[encoding].sha256 &&
				proxied.bytes === native[encoding].bytes &&
				proxied.encoding === native[encoding].encoding &&
				proxied.length === native[encoding].length,
			`native ${JSON.stringify(native[encoding])} proxied ${JSON.stringify(proxied)}`,
		);
	}

	// the origin drops the connection a quarter of the way: the page's read
	// fails, as natively, instead of ending early as if it were whole
	const truncated = await frame
		.evaluate(readCut, `${ORIGIN}truncated`)
		.catch((error) => String(error).slice(0, 200));
	ok(
		`${mode}: a body the origin cuts short fails the page's read, as natively`,
		truncated === native.truncated,
		JSON.stringify({ native: native.truncated, proxied: truncated }),
	);

	// cancelled after the first megabyte: the transport stops reading and
	// the origin's connection goes
	const cancelId = `cancel-${mode}`;
	const cancelled = await frame
		.evaluate(
			async (url) => {
				const response = await fetch(url, { cache: 'no-store' });
				const reader = response.body.getReader();
				let read = 0;
				while (read < 1024 * 1024) read += (await reader.read()).value.length;
				await reader.cancel();
				return read;
			},
			`${ORIGIN}endless?id=${cancelId}&limit=${256 * 1024 * 1024}`,
		)
		.catch((error) => String(error).slice(0, 200));
	let closed = false;
	for (let i = 0; i < 40 && !closed; i++) {
		await sleep(250);
		closed = !!endless.get(cancelId)?.closed;
	}
	ok(
		`${mode}: a body the page cancels closes the origin's response`,
		typeof cancelled === 'number' && closed,
		JSON.stringify({ cancelled, origin: endless.get(cancelId) }),
	);

	// not read at all for two seconds, then read: the transport stopped
	// pushing at its window and starts again as the page takes the body. (The
	// origin itself does not stop: wisp has no flow control towards the
	// client, and epoxy queues a stream's data unbounded until it is read;
	// see CHANGELOG known limitations.)
	const stallId = `stall-${mode}`;
	await frame.evaluate(
		(url) => {
			window.__stalled = fetch(url, { cache: 'no-store' });
		},
		`${ORIGIN}endless?id=${stallId}&limit=${48 * 1024 * 1024}`,
	);
	await sleep(2000);
	// reading it again takes the rest as it comes
	const resumed = await frame
		.evaluate(async () => {
			const response = await window.__stalled;
			const reader = response.body.getReader();
			let read = 0;
			while (read < 32 * 1024 * 1024)
				read += (await reader.read()).value.length;
			await reader.cancel();
			return read;
		})
		.catch((error) => String(error).slice(0, 200));
	ok(
		`${mode}: a body left unread for two seconds flows again once the page reads it`,
		typeof resumed === 'number' && resumed >= 32 * 1024 * 1024,
		JSON.stringify({ resumed, origin: endless.get(stallId)?.written }),
	);

	if (mode === 'same-origin') {
		// the transport straight from the host page, with no worker in the
		// path: the RemoteTransport the controller hands the host
		const direct = await page.evaluate(
			async ({ origin, encodings }) => {
				const out = {};
				for (const encoding of encodings) {
					const response = await window.controller.transport.request(
						new URL(`${origin}big.js?enc=${encoding}`),
						'GET',
						null,
						[],
						undefined,
					);
					const buffer = await new Response(response.body).arrayBuffer();
					const hash = await crypto.subtle.digest('SHA-256', buffer);
					out[encoding] = {
						bytes: buffer.byteLength,
						sha256: [...new Uint8Array(hash)]
							.map((b) => b.toString(16).padStart(2, '0'))
							.join(''),
						encoding:
							response.headers.find(
								([name]) => name.toLowerCase() === 'content-encoding',
							)?.[1] ?? null,
					};
				}
				return out;
			},
			{ origin: ORIGIN, encodings: Object.keys(variants) },
		);
		for (const encoding of Object.keys(variants))
			ok(
				`transport: ${encoding}: the body arrives decoded, byte for byte, with the origin's Content-Encoding`,
				direct[encoding]?.sha256 === digest &&
					direct[encoding]?.encoding ===
						(encoding === 'identity' ? null : encoding),
				JSON.stringify(direct[encoding]),
			);
	}
	await page.close();
}

server.close();
server.closeAllConnections();
await done(browser);
