// What the host's server learns of the sites of Tor mode (docs/tor.md
// "What our server sees"). A proxied page's requests are its service
// worker's to answer, but some reach the server at their route all the
// same: a forced reload of a page at the top of a tab of its own goes past
// the worker, as does such a tab's favicon request with the route as its
// Referer; a page whose tab is gone finds no controller once the worker has
// started again, and the worker handed its requests to the network; a
// dialed page's about:blank frame resolved its URLs against the call page.
// The demo runs behind a front server here that records every request the
// browser makes of it (method, path and query, Referer, body), and the
// checks read those for the site's address: as it is, percent-decoded, in
// the generic codec's `$xx` form, in base64 or hex, and as a reader of the
// routes reads them who knows the URL of one other page the user visited
// (the xor codec's stream is the same for every URL under a key: a route's
// seal XORed with the URL it seals gives the stream, which opens the
// others).
//
// Tor mode seals its routes with the siv codec, whose key the server never
// has, and its worker answers every request at its routes itself, so none
// of it names the site; normal mode keeps xor, and the same reading
// recovers its site from two of its routes (so the check reads what a
// server could). The server answers Tor mode with the stand-in
// (STOMP_TOR_CLIENT=stand-in): what is checked is the routes, not Tor. It
// runs on a classic server (test/run.mjs CLASSIC_SUITES), the dialed tab
// with ?mode=just-call-stomp.
/* global DIRECTORY, controller */
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import {
	activeFrame,
	done,
	launch,
	ok,
	PORT,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

/** the site's secret: a path segment of every URL of it the checks visit */
const SECRET = `s3cr3t${Math.random().toString(36).slice(2, 10)}`;
/** the page whose URL the reader of the routes knows (a public one, say) */
const PUBLIC = 'a-public-page-whose-address-anyone-could-guess-from-its-name';

const PIXEL = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64',
);
// what a page's script asks, on a message: on `ask`, an image, a
// stylesheet, and a POST and a beacon whose bodies are its address; on
// `frames`, an about:blank frame and a srcdoc frame that each load an image
// and a stylesheet by a relative URL, then the title tells the images' widths
const SCRIPT = `<script>
addEventListener('message', (event) => {
	if (event.data === 'ask') {
		const image = new Image();
		image.src = 'asked.png';
		document.body.append(image);
		const sheet = document.createElement('link');
		sheet.rel = 'stylesheet';
		sheet.href = 'asked.css';
		document.head.append(sheet);
		fetch('asked', { method: 'POST', body: location.href }).catch(() => {});
		navigator.sendBeacon('beacon', location.href);
	}
	if (event.data === 'frames') {
		const images = [];
		const blank = document.createElement('iframe');
		document.body.append(blank);
		const inBlank = blank.contentDocument;
		const image = inBlank.createElement('img');
		image.src = 'blank.png';
		inBlank.body.append(image);
		const sheet = inBlank.createElement('link');
		sheet.rel = 'stylesheet';
		sheet.href = 'blank.css';
		inBlank.head.append(sheet);
		images.push(image);
		const srcdoc = document.createElement('iframe');
		srcdoc.srcdoc = '<link rel=stylesheet href="srcdoc.css"><img src="srcdoc.png">';
		srcdoc.onload = () => images.push(srcdoc.contentDocument.querySelector('img'));
		document.body.append(srcdoc);
		setTimeout(() => {
			document.title = 'FRAMES ' + images.map((one) => one.naturalWidth).join(',');
		}, 2000);
	}
});
</script>`;

const site = createServer((req, res) => {
	const { pathname } = new URL(req.url, 'http://site');
	const headers = { 'cache-control': 'no-store' };
	if (pathname.endsWith('.png')) {
		res.writeHead(200, { ...headers, 'content-type': 'image/png' });
		return res.end(PIXEL);
	}
	if (pathname.endsWith('.css')) {
		res.writeHead(200, { ...headers, 'content-type': 'text/css' });
		return res.end('body { margin: 1px }');
	}
	if (req.method === 'POST') {
		req.resume();
		res.writeHead(204, headers);
		return res.end();
	}
	const title = pathname.startsWith(`/${SECRET}/`) ? 'SECRET' : 'PUBLIC';
	res.writeHead(200, { ...headers, 'content-type': 'text/html' });
	res.end(
		`<!doctype html><meta charset="utf-8"><title>${title}</title><body>${SCRIPT}</body>`,
	);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const SITE = `http://127.0.0.1:${site.address().port}`;
const SECRET_PAGE = `${SITE}/${SECRET}/index.html`;
const PUBLIC_PAGE = `${SITE}/${PUBLIC}/index.html`;

// the demo behind a front that records what the browser asks of it
await waitForServer(`http://127.0.0.1:${PORT}/`);
const demo = Number(PORT);
/** every request that reached the server: { method, url, referer, body } */
const hits = [];
const front = createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		hits.push({
			method: req.method,
			url: req.url,
			referer: req.headers.referer ?? '',
			body: body.toString('latin1'),
		});
		const upstream = request(
			{
				host: '127.0.0.1',
				port: demo,
				path: req.url,
				method: req.method,
				headers: req.headers,
			},
			(answer) => {
				res.writeHead(answer.statusCode, answer.headers);
				answer.pipe(res);
			},
		);
		upstream.on('error', () => res.destroy());
		upstream.end(body);
	});
});
// the wisp socket, as it came (its streams are the transport's)
front.on('upgrade', (req, socket, head) => {
	hits.push({
		method: 'UPGRADE',
		url: req.url,
		referer: req.headers.referer ?? '',
		body: '',
	});
	const upstream = connect(demo, '127.0.0.1', () => {
		let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
		for (let i = 0; i < req.rawHeaders.length; i += 2)
			text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
		upstream.write(`${text}\r\n`);
		upstream.write(head);
		socket.pipe(upstream);
		upstream.pipe(socket);
	});
	upstream.on('error', () => socket.destroy());
	socket.on('error', () => upstream.destroy());
});
await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
const HOSTED = `http://127.0.0.1:${front.address().port}/`;

/** the runs of a text that may be base64 (a seal among them) */
const runsOf = (text) => text.match(/[A-Za-z0-9+/_=-]{8,}/g) ?? [];
const fromBase64 = (run) =>
	Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** every reading of `text` a server could make without a key */
function readings(text) {
	const out = [text];
	let decoded = text;
	for (let i = 0; i < 3; i++)
		try {
			decoded = decodeURIComponent(decoded);
			out.push(decoded);
		} catch {
			break;
		}
	// the generic codec's `$xx` (src/Codecs.ts encodeCodecURI)
	out.push(
		text.replace(/\$([0-9a-f]{2})/gi, (_, hex) =>
			String.fromCharCode(parseInt(hex, 16)),
		),
	);
	for (const run of runsOf(text))
		for (let skip = 0; skip < 4; skip++)
			out.push(fromBase64(run.slice(skip)).toString('latin1'));
	for (const run of text.match(/[0-9a-f]{16,}/gi) ?? [])
		out.push(
			Buffer.from(run.slice(0, run.length & ~1), 'hex').toString('latin1'),
		);
	return out;
}

/** what names the site: its secret path segment, or its host and port */
const names = (text) =>
	text.includes(SECRET) || text.includes(new URL(SITE).host);

/**
 * What of `list` names the site: a hit, in any reading of its path, query,
 * Referer or body, or a pair of seals (base64url runs), one opening the
 * other with the public page's URL as the text the first seals
 */
function revealing(list) {
	const found = [];
	for (const hit of list)
		for (const field of ['url', 'referer', 'body'])
			if (readings(hit[field]).some(names))
				found.push({ field, hit: `${hit.method} ${hit[field]}` });
	const known = Buffer.from(PUBLIC_PAGE, 'latin1');
	const seals = new Set(
		list.flatMap((hit) =>
			[hit.url, hit.referer].flatMap((text) => text.match(/[\w-]{22,}/g) ?? []),
		),
	);
	for (const one of seals)
		for (const other of seals) {
			if (one === other) continue;
			const a = fromBase64(one);
			const b = fromBase64(other);
			const length = Math.min(a.length, b.length, known.length);
			const opened = Buffer.alloc(length);
			for (let at = 0; at < length; at++)
				opened[at] = b[at] ^ a[at] ^ known[at];
			// (the known text names the host: what it opens must name the page)
			if (opened.toString('latin1').includes(SECRET))
				found.push({ stream: one, opened: opened.toString('latin1') });
		}
	return found;
}

/** the requests at a route of `directory` (`<directory><id>/<kind>/<seal>`) */
const routed = (list, directory) =>
	list.filter(
		(hit) =>
			hit.url.startsWith(directory) &&
			/^[\w-]+\/./.test(hit.url.slice(directory.length)),
	);

const errors = [];

async function demoPage(context, query) {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${HOSTED}${query}`);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 60000 },
	);
	const state = await page.evaluate(() => ({
		directory: DIRECTORY,
		codec: controller?.config?.codec ?? null,
	}));
	return { page, ...state };
}

/** the active frame of `page`, once its document's title is `title` */
async function titled(page, title, ms = 40000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const frame = await activeFrame(page);
		if (frame && (await frame.title().catch(() => null)) === title)
			return frame;
		await sleep(250);
	}
	return null;
}

/** `message` dispatched in `frame`, as the page's script takes it */
const tell = (frame, message) =>
	frame
		?.evaluate(
			(data) => dispatchEvent(new MessageEvent('message', { data })),
			message,
		)
		.catch(() => {});

/** a page of its own at `route`, forced to reload (Ctrl+Shift+R) once it is there */
async function ownTabReloaded(context, route, title) {
	const tab = await context.newPage();
	tab.on('pageerror', (error) => errors.push(error.message));
	await tab.goto(route);
	const before = await tab.title();
	const cdp = await context.newCDPSession(tab);
	await cdp.send('Page.reload', { ignoreCache: true });
	let after = null;
	for (let i = 0; i < 60 && after !== title; i++) {
		await sleep(250);
		after = await tab.title().catch(() => null);
	}
	await cdp.detach();
	return { tab, before, after };
}

const browser = await launch();

// ---- Tor mode, a classic tab
const tor = await browser.newContext();
const torStart = hits.length;
const torHost = await demoPage(tor, '?tor=1');
await submitLanding(torHost.page, PUBLIC_PAGE);
const publicRoute = (await titled(torHost.page, 'PUBLIC'))?.url() ?? '';
await submitLanding(torHost.page, SECRET_PAGE);
const secretFrame = await titled(torHost.page, 'SECRET');
const secretRoute = secretFrame?.url() ?? '';

await tell(secretFrame, 'frames');
const framed = await titled(torHost.page, 'FRAMES 1,1', 10000);
ok(
	"a Tor page's about:blank and srcdoc frames load their images",
	!!framed,
	JSON.stringify(
		await (await activeFrame(torHost.page))?.title().catch(() => null),
	),
);

// a forced reload of each page at the top of a tab of its own: past the
// worker, to the server at its route, and back through the worker
const reloadStart = hits.length;
const publicTab = await ownTabReloaded(tor, publicRoute, 'PUBLIC');
const secretTab = await ownTabReloaded(tor, secretRoute, 'SECRET');
const reloadHits = routed(hits.slice(reloadStart), torHost.directory);
ok(
	'a forced reload of a Tor page in a tab of its own reaches the server at its route, and the page comes back',
	publicTab.before === 'PUBLIC' &&
		publicTab.after === 'PUBLIC' &&
		secretTab.before === 'SECRET' &&
		secretTab.after === 'SECRET' &&
		reloadHits.some((hit) => hit.url.startsWith(new URL(secretRoute).pathname)),
	JSON.stringify({
		public: [publicTab.before, publicTab.after],
		secret: [secretTab.before, secretTab.after],
		hits: reloadHits.map((hit) => hit.url.slice(0, 60)),
	}),
);

// the Tor tab gone and the worker started again: no controller comes back
// for the page's route, and what the page asks no one answers
await torHost.page.close();
{
	const cdp = await tor.newCDPSession(secretTab.tab);
	await cdp.send('ServiceWorker.enable');
	await cdp.send('ServiceWorker.stopAllWorkers');
	await cdp.detach();
	await sleep(1000);
}
const orphanStart = hits.length;
await tell(secretTab.tab.mainFrame(), 'ask');
// (the worker holds a request of a route with no controller 3 s for one to
// come back: src/server/serviceWorker.ts REVIVE_HOLD_MS)
await sleep(6000);
const orphanHits = routed(hits.slice(orphanStart), torHost.directory);
ok(
	"with its tab gone, a Tor page's image, stylesheet, POST and beacon reach no server",
	orphanHits.length === 0,
	JSON.stringify(
		orphanHits.map((hit) => `${hit.method} ${hit.url.slice(0, 60)}`),
	),
);
const navigationStart = hits.length;
const again = await tor.newPage();
await again.goto(secretRoute).catch(() => {});
const againTitle = await again.title().catch(() => null);
const navigationHits = routed(hits.slice(navigationStart), torHost.directory);
ok(
	'a navigation to a Tor route whose tab is gone is answered by the worker, not by the server',
	againTitle === 'Not available' && navigationHits.length === 0,
	JSON.stringify({
		againTitle,
		hits: navigationHits.map((hit) => hit.url.slice(0, 60)),
	}),
);
await tor.close();

// ---- Tor mode, a dialed tab: an about:blank frame's base is the call
// page's address, which is no route
const dialed = await browser.newContext();
const dialHost = await demoPage(dialed, '?tor=1&mode=just-call-stomp');
await submitLanding(dialHost.page, SECRET_PAGE);
const dialFrame = await titled(dialHost.page, 'SECRET');
const dialStart = hits.length;
await tell(dialFrame, 'frames');
const dialFramed = await titled(dialHost.page, 'FRAMES 1,1', 10000);
const dialHits = hits
	.slice(dialStart)
	.filter((hit) => /(blank|srcdoc)\.(png|css)/.test(hit.url));
ok(
	"a dialed Tor page's about:blank and srcdoc frames load their images through the worker, and the server sees none of their URLs",
	!!dialFramed && dialHits.length === 0,
	JSON.stringify({
		title: await (await activeFrame(dialHost.page))?.title().catch(() => null),
		hits: dialHits.map((hit) => hit.url),
	}),
);
await dialed.close();
const torHits = hits.slice(torStart);

ok(
	'Tor mode seals its routes with the siv codec, in a classic tab and a dialed one',
	torHost.codec === 'siv' && dialHost.codec === 'siv',
	JSON.stringify([torHost.codec, dialHost.codec]),
);
const torRevealing = revealing(torHits);
ok(
	'no request the server received in Tor mode names the site, in any reading of its path, query, Referer or body',
	torRevealing.length === 0 && reloadHits.length > 0,
	JSON.stringify(torRevealing.slice(0, 3)).slice(0, 1500),
);

// ---- normal mode: xor, its pages as before, and the same reading
// recovers its site from two of its routes once they reach the server
const normal = await browser.newContext();
const normalHost = await demoPage(normal, '?notor');
const normalStart = hits.length;
await submitLanding(normalHost.page, PUBLIC_PAGE);
const normalPublic = (await titled(normalHost.page, 'PUBLIC'))?.url() ?? '';
await submitLanding(normalHost.page, SECRET_PAGE);
const normalSecret = (await titled(normalHost.page, 'SECRET'))?.url() ?? '';
const normalPublicTab = await ownTabReloaded(normal, normalPublic, 'PUBLIC');
const normalSecretTab = await ownTabReloaded(normal, normalSecret, 'SECRET');
const normalRevealing = revealing(hits.slice(normalStart));
ok(
	"normal mode keeps the xor codec and its pages, and the check's reading of the server's requests recovers its site from two of its routes",
	normalHost.codec === 'xor' &&
		normalPublicTab.after === 'PUBLIC' &&
		normalSecretTab.after === 'SECRET' &&
		normalRevealing.some((found) => found.stream),
	JSON.stringify({
		codec: normalHost.codec,
		after: [normalPublicTab.after, normalSecretTab.after],
		found: normalRevealing.length,
	}),
);
await normal.close();

ok('no page errors', errors.length === 0, JSON.stringify(errors));
front.closeAllConnections();
front.close();
site.close();
await done(browser);
