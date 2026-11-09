// Measurement: how long a 12 MB body takes after its headers, plain and
// pre-compressed (gzip, br), at each layer it crosses, from a server this
// suite runs on loopback (no network, no rewriting: the body is fetched as
// data). Printed as a table; SKIP_MEASUREMENT=1 leaves the suite out.
//
//   native        the browser itself, no proxy
//   epoxy         an epoxy instance in the host page: wisp, TLS-less HTTP/1.1,
//                 decompression in wasm, the chunks into JS
//   transport     the controller's transport (its worker) through a
//                 RemoteTransport, the body on a port of its own
//   transport+queue
//                 the same while the reading page's task queue always holds
//                 20 short tasks, as the service worker's does while a site
//                 loads
//   worker        a proxied page's fetch through the service worker, the body
//                 paced over about 400 ms as from a CDN
//   worker+load   the same beside 250 stylesheets the worker rewrites and 250
//                 small fetches, the case a large site's first load is
//                 (Discord's 12 MB bundle loads beside ~500 other requests)
//
// Before the body ports a transferred stream moved one 16 KiB chunk per round
// trip between the transport's worker and the reader, and each round trip
// waited behind the reader's queued tasks: Discord's bundle took 1.4 s to
// read under load where the transport had it in 0.4 s. Measured on a 32-core
// machine, medians in ms (identity / gzip / br):
//
//                    before               after
//   transport          68 /   83 /   74     64 /  64 /  59
//   transport+queue  5518 / 4415 / 4420     73 /  72 /  61
//   worker+load       992 /  983 / 1042    794 / 870 / 972
//
// What is left of worker+load is the worker rewriting the stylesheets. The
// check is loose, so a slow runner does not fail it: a reader with a busy
// queue takes at most a few times what an idle one does.
import { createServer } from 'node:http';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import {
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const SIZE = 12 * 1000 * 1000;
const RUNS = 3;
const FANOUT = 250;
const QUEUE = 20;

function bundle(size) {
	let seed = 0x1b873593;
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
const small = gzipSync(bundle(40 * 1000));
// a stylesheet the worker rewrites (its url()s are routed): what keeps the
// worker busy while a large site loads
const sheet = gzipSync(
	Array.from(
		{ length: 400 },
		(_, i) =>
			`.c${i} .d${i}>a:hover{background:url(/img/${i}.png) no-repeat;margin:${i}px ${i % 7}px;color:#${(i * 2654435761).toString(16).slice(-6)}}`,
	).join('\n'),
);

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>MEASURE</title><p>measure</p>');
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
		if (!url.searchParams.has('paced')) return res.end(body);
		// paced at about 25 MB/s, as from a CDN: the body arrives over a few
		// hundred ms, while the page's other requests are in flight
		let at = 0;
		const step = Math.ceil(body.length / 200);
		const next = () => {
			if (at >= body.length) return res.end();
			res.write(body.subarray(at, (at += step)));
			setTimeout(next, 2);
		};
		next();
	} else if (url.pathname === '/sheet.css') {
		res.writeHead(200, {
			'content-type': 'text/css',
			'content-encoding': 'gzip',
			'content-length': sheet.length,
			'cache-control': 'no-store',
		});
		res.end(sheet);
	} else if (url.pathname === '/small.js') {
		res.writeHead(200, {
			'content-type': 'text/javascript',
			'content-encoding': 'gzip',
			'content-length': small.length,
			'cache-control': 'no-store',
		});
		res.end(small);
	} else res.writeHead(404).end();
});
// the default keep-alive closes idle connections under the measurement
server.keepAliveTimeout = 60 * 1000;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/**
 * in a page: fetch `url` and time its body; with `fanout`, beside that many
 * stylesheets (the worker rewrites each) and as many small fetches
 */
const timeBody = async ({ url, fanout, origin }) => {
	const others = [];
	for (let i = 0; i < fanout; i++) {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = `${origin}sheet.css?${Math.random()}`;
		others.push(
			new Promise((resolve) => {
				link.onload = link.onerror = resolve;
			}),
		);
		document.head.append(link);
		others.push(
			fetch(`${origin}small.js?${Math.random()}`, { cache: 'no-store' }).then(
				(r) => r.arrayBuffer(),
			),
		);
	}
	const response = await fetch(url, { cache: 'no-store' });
	const headers = performance.now();
	const bytes = (await response.arrayBuffer()).byteLength;
	const ms = performance.now() - headers;
	await Promise.all(others);
	for (const link of document.querySelectorAll('link')) link.remove();
	return { bytes, ms };
};

/**
 * in the host page: the same through a transport object. With `queue`, the
 * page keeps that many short tasks (0.25 ms each) queued as messages while
 * it reads, the way the service worker's queue holds other requests' work
 * while a site loads: a message the transport sends waits behind them
 */
const timeTransport = async ({ url, direct, wisp, queue }) => {
	let busy = false;
	if (queue) {
		busy = true;
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			const until = performance.now() + 0.25;
			while (performance.now() < until);
			if (busy) channel.port2.postMessage(0);
		};
		for (let i = 0; i < queue; i++) channel.port2.postMessage(0);
	}
	let transport = window.controller.transport;
	if (direct) {
		window.__epoxy ??= (async () => {
			const { default: Epoxy } = await import('/epoxy/index.mjs');
			const epoxy = new Epoxy({ wisp });
			await epoxy.init();
			return epoxy;
		})();
		transport = await window.__epoxy;
	}
	const response = await transport.request(
		new URL(url),
		'GET',
		null,
		[],
		undefined,
	);
	const headers = performance.now();
	const reader = response.body.getReader();
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
	}
	busy = false;
	return { bytes, ms: performance.now() - headers };
};

const median = (values) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const table = {};
const record = (layer, encoding, results) => {
	table[layer] ??= {};
	table[layer][encoding] = Math.round(median(results.map((r) => r.ms)));
	return results.every((r) => r.bytes === SIZE);
};

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
for (const encoding of Object.keys(variants)) {
	const results = [];
	for (let i = 0; i < RUNS; i++)
		results.push(
			await nativePage.evaluate(timeBody, {
				url: `${ORIGIN}big.js?enc=${encoding}`,
				fanout: 0,
				origin: ORIGIN,
			}),
		);
	ok(`native: ${encoding} arrives whole`, record('native', encoding, results));
}
await nativePage.close();

const page = await openDemo(browser, PROXY);
for (const [layer, direct, queue] of [
	['epoxy', true, 0],
	['transport', false, 0],
	['transport+queue', false, QUEUE],
])
	for (const encoding of Object.keys(variants)) {
		const results = [];
		for (let i = 0; i < RUNS; i++)
			results.push(
				await page.evaluate(timeTransport, {
					url: `${ORIGIN}big.js?enc=${encoding}`,
					direct,
					queue,
					wisp: `${PROXY.replace(/^http/, 'ws')}wisp/`,
				}),
			);
		ok(`${layer}: ${encoding} arrives whole`, record(layer, encoding, results));
	}

await submitLanding(page, `${ORIGIN}page.html`);
let frame = null;
for (let i = 0; i < 120 && !frame; i++) {
	const found = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
	if (
		(await found?.evaluate(() => document.title).catch(() => null)) ===
		'MEASURE'
	)
		frame = found;
	else await sleep(250);
}
ok('the proxied page loads', !!frame);
if (frame)
	for (const [layer, fanout] of [
		['worker', 0],
		['worker+load', FANOUT],
	])
		for (const encoding of Object.keys(variants)) {
			const results = [];
			for (let i = 0; i < RUNS; i++)
				results.push(
					await frame.evaluate(timeBody, {
						url: `${ORIGIN}big.js?enc=${encoding}&paced`,
						fanout,
						origin: ORIGIN,
					}),
				);
			ok(
				`${layer}: ${encoding} arrives whole`,
				record(layer, encoding, results),
			);
		}

console.log('12 MB body, ms from the headers to the last byte (median of 3):');
console.table(table);
for (const encoding of Object.keys(variants)) {
	const alone = table.transport?.[encoding];
	const queued = table['transport+queue']?.[encoding];
	ok(
		`transport+queue: ${encoding} is read in at most 4x its time with an idle reader (plus 200 ms)`,
		alone !== undefined && queued !== undefined && queued <= alone * 4 + 200,
		`idle ${alone} ms, with ${QUEUE} tasks queued ${queued} ms`,
	);
}

server.close();
server.closeAllConnections();
await done(browser);
