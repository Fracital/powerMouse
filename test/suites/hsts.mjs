// HSTS as Chrome keeps it, per network partition (src/server/hsts.ts). The
// worker drops Strict-Transport-Security (it would pin the proxy's host) and
// keeps it itself: an https answer of mixed.test with the header makes an
// http link, a typed http URL and a subdomain under includeSubDomains load
// over https (the frame's location says which), max-age=0 forgets it, a
// page of another site (its own partition) fetches, frames and opens a
// WebSocket to http mixed.test as written until an https answer in that
// partition says so, after which its fetch's URL is https and its ws:
// socket goes out as wss: (a TLS hello reaches the server). An address
// (127.0.0.2) is never kept. What is kept outlives the service worker, and
// clearCache(), forgetStorage(origin) and Clear-Site-Data "cache" forget it.
// Not compared natively: Chrome takes HSTS only over a certificate it
// trusts, which the fixture has not. The test transport
// (demo/public/test/mixed-transport.mjs) takes the https and wss URLs of
// mixed.test, of the names under h3.mixed.test, of stomp-a.github.io and of
// 127.0.0.2 to this suite's server in plain http, and those of the other
// names under mixed.test (ws.mixed.test) in TLS, which the server counts.
import { createServer as createHTTP } from 'node:http';
import { createServer as createNet } from 'node:net';
import { WebSocketServer } from 'ws';
import {
	activeFrame,
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

/** every request the server got: `{ path, c, method }` */
const log = [];
/** TLS hellos the server got (a wss: or https: URL of ws.mixed.test) */
let tlsHellos = 0;
const http = createHTTP((req, res) => {
	const url = new URL(req.url, 'http://hsts.test/');
	log.push({
		path: url.pathname,
		c: url.searchParams.get('c'),
		method: req.method,
	});
	const headers = {
		'access-control-allow-origin': '*',
		'cache-control': 'no-store',
	};
	if (url.pathname === '/sts' || url.pathname === '/page') {
		if (url.searchParams.has('h'))
			headers['strict-transport-security'] = url.searchParams.get('h');
		if (url.searchParams.has('csd'))
			headers['clear-site-data'] = url.searchParams.get('csd');
		res.writeHead(200, { ...headers, 'content-type': 'text/html' });
		// (the page's own script reads its location as the page has it: a
		// script of the suite's is not rewritten, and reads the routed one)
		res.end(
			`<!doctype html><title>${url.pathname.slice(1)}</title><p>hi<script>window.__href = location.href;</script>`,
		);
		return;
	}
	if (url.pathname === '/data') {
		res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
		res.end('data');
		return;
	}
	res.writeHead(404, headers).end();
});
new WebSocketServer({ server: http }).on('connection', (socket, req) => {
	const url = new URL(req.url, 'http://hsts.test/');
	log.push({
		path: url.pathname,
		c: url.searchParams.get('c'),
		method: 'WebSocket',
	});
	socket.close();
});
// one port: a connection that opens with a TLS record is only counted
const server = createNet((socket) => {
	socket.on('error', () => {});
	socket.once('readable', () => {
		const chunk = socket.read();
		if (!chunk) return socket.destroy();
		if (chunk[0] === 0x16) {
			tlsHellos++;
			return socket.destroy();
		}
		socket.unshift(chunk);
		http.emit('connection', socket);
	});
});
const PORT = await new Promise((resolve) =>
	server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
);
const at = (scheme, host, path) => `${scheme}://${host}:${PORT}${path}`;

const browser = await launch();
const page = await openDemo(browser, PROXY);

/** the active tab's document once it is the one tagged `c`, by its real URL */
async function landed(c, timeout = 30000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const frame = await activeFrame(page);
		const href = await frame
			?.evaluate(() =>
				document.readyState === 'complete' ? (window.__href ?? '') : '',
			)
			.catch(() => '');
		if (href && new URL(href).searchParams.get('c') === c) return href;
		await sleep(200);
	}
	return null;
}

/** navigate the active tab (the first time, open one) and wait for `c` */
let opened = false;
async function visit(url) {
	const c = new URL(url).searchParams.get('c');
	if (opened) await submitOmni(page, url);
	else await submitLanding(page, url);
	opened = true;
	return landed(c);
}

/** the scheme a tagged load ended on ('none' when it never did) */
const schemeOf = (href) => (href ? new URL(href).protocol : 'none');

/** run `fn` in the active tab's document */
async function inPage(fn, arg) {
	const frame = await activeFrame(page);
	return frame.evaluate(fn, arg);
}

/** a frame of the page whose real URL is tagged `c`, as its location says */
async function frameLanded(c, timeout = 20000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		for (const frame of page.frames()) {
			const href = await frame
				.evaluate(() =>
					document.readyState === 'complete' ? (window.__href ?? '') : '',
				)
				.catch(() => '');
			if (href && new URL(href).searchParams.get('c') === c) return href;
		}
		await sleep(200);
	}
	return null;
}

const sts = (value, c, host = 'mixed.test') =>
	at('https', host, `/sts?h=${encodeURIComponent(value)}&c=${c}`);

// 1. one site's top-level partition
ok(
	'before any answer, an http URL loads over http',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=p0'))) === 'http:',
);
ok(
	'an https answer with HSTS loads',
	schemeOf(await visit(sts('max-age=600', 'p1'))) === 'https:',
);
await inPage(
	(href) => {
		const a = document.createElement('a');
		a.href = href;
		document.body.append(a);
		a.click();
	},
	at('http', 'mixed.test', '/page?c=p2'),
);
const linked = await landed('p2');
ok(
	'an http link to the same host then loads over https, its port kept',
	linked === at('https', 'mixed.test', '/page?c=p2'),
	String(linked),
);
ok(
	'and so does an http URL typed in',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=p3'))) === 'https:',
);
ok(
	'a subdomain is not upgraded without includeSubDomains',
	schemeOf(await visit(at('http', 'x.h3.mixed.test', '/page?c=p4'))) ===
		'http:',
);
await visit(sts('max-age=600; includeSubDomains', 'p5'));
ok(
	'with includeSubDomains a subdomain loads over https',
	schemeOf(await visit(at('http', 'x.h3.mixed.test', '/page?c=p6'))) ===
		'https:',
);
ok(
	'an invalid header changes nothing (max-age twice)',
	schemeOf(await visit(sts('max-age=0; max-age=0', 'p7'))) === 'https:' &&
		schemeOf(await visit(at('http', 'mixed.test', '/page?c=p8'))) === 'https:',
);
await visit(sts('max-age=0', 'p9'));
ok(
	'max-age=0 forgets the host',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=p10'))) === 'http:',
);
ok(
	'and its subdomains with it',
	schemeOf(await visit(at('http', 'x.h3.mixed.test', '/page?c=p11'))) ===
		'http:',
);

// 2. another site's partition: what the top-level mixed.test keeps is not
// its own
await visit(sts('max-age=600; includeSubDomains', 'q0'));
ok(
	'another site loads',
	schemeOf(await visit(at('http', 'stomp-a.github.io', '/page?c=q1'))) ===
		'http:',
);
const fetched = (url) =>
	inPage(async (href) => {
		try {
			return (await fetch(href)).url;
		} catch (error) {
			return `failed: ${error}`;
		}
	}, url);
const fetchedBefore = await fetched(at('http', 'mixed.test', '/data?c=q2'));
ok(
	"its fetch of http mixed.test is not upgraded by the other partition's HSTS",
	fetchedBefore === at('http', 'mixed.test', '/data?c=q2'),
	fetchedBefore,
);
await inPage(
	(src) => {
		const frame = document.createElement('iframe');
		frame.src = src;
		document.body.append(frame);
	},
	at('http', 'mixed.test', '/page?c=q3'),
);
const framedBefore = await frameLanded('q3');
ok(
	'nor is its frame of http mixed.test',
	schemeOf(framedBefore) === 'http:',
	String(framedBefore),
);
/** open a WebSocket from the page and wait for it to end */
const socket = (url) =>
	inPage(
		(href) =>
			new Promise((resolve) => {
				const ws = new WebSocket(href);
				const timer = setTimeout(() => resolve('timeout'), 8000);
				ws.onclose = () => {
					clearTimeout(timer);
					resolve(ws.url);
				};
			}),
		url,
	);
let hellos = tlsHellos;
await socket(at('ws', 'ws.mixed.test', '/w?c=q4'));
ok(
	'nor its ws: socket to a subdomain',
	log.some((entry) => entry.method === 'WebSocket' && entry.c === 'q4') &&
		tlsHellos === hellos,
	`${tlsHellos - hellos} TLS hellos`,
);
const setInPartition = await fetched(
	sts('max-age=600; includeSubDomains', 'q5'),
);
const fetchedAfter = await fetched(at('http', 'mixed.test', '/data?c=q6'));
ok(
	'after an https answer with HSTS in its own partition, its fetch of http goes over https',
	setInPartition === sts('max-age=600; includeSubDomains', 'q5') &&
		fetchedAfter === at('https', 'mixed.test', '/data?c=q6'),
	`${setInPartition} ${fetchedAfter}`,
);
hellos = tlsHellos;
const wsURL = await socket(at('ws', 'ws.mixed.test', '/w?c=q7'));
ok(
	'and its ws: socket to a subdomain goes out as wss: (its url unchanged)',
	!log.some((entry) => entry.method === 'WebSocket' && entry.c === 'q7') &&
		tlsHellos > hellos &&
		wsURL === at('ws', 'ws.mixed.test', '/w?c=q7'),
	`${tlsHellos - hellos} TLS hellos, ${wsURL}`,
);
await inPage(
	(src) => {
		const frame = document.createElement('iframe');
		frame.src = src;
		document.body.append(frame);
	},
	at('http', 'mixed.test', '/page?c=q8'),
);
const framedAfter = await frameLanded('q8');
ok(
	'a frame is a partition of its own (cross-site to its top): still http',
	schemeOf(framedAfter) === 'http:',
	String(framedAfter),
);

// 3. kept across a restart of the service worker
const cdp = await page.context().newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await cdp.detach();
await sleep(1000);
ok(
	'what is kept outlives the service worker',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=r0'))) === 'https:',
);

// 4. the clear paths
await page.evaluate(() => window.controller.clearCache());
ok(
	'clearCache() forgets it',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=r1'))) === 'http:',
);
await visit(sts('max-age=600', 'r2'));
await page.evaluate(
	(origin) => window.controller.forgetStorage(origin),
	`https://mixed.test:${PORT}`,
);
ok(
	'forgetStorage(origin) forgets its site',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=r3'))) === 'http:',
);
await visit(sts('max-age=600', 'r4'));
await visit(
	at('https', 'mixed.test', `/page?csd=${encodeURIComponent('"cache"')}&c=r5`),
);
ok(
	'Clear-Site-Data "cache" forgets it',
	schemeOf(await visit(at('http', 'mixed.test', '/page?c=r6'))) === 'http:',
);

// 5. an IP literal
ok(
	'an https answer of an address with HSTS loads',
	schemeOf(await visit(sts('max-age=600', 's0', '127.0.0.2'))) === 'https:',
);
ok(
	'and the address is not kept: http stays http',
	schemeOf(await visit(at('http', '127.0.0.2', '/page?c=s1'))) === 'http:',
);

ok('no page errors in the host', !page.errors.length, page.errors.join('; '));
await browser.close();
server.close();
await done();
