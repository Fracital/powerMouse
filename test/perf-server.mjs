// The Performance API side of the fixture (performance-* suites): resources
// whose every header a timing entry shows is chosen by the URL, so the same
// page loads the same mix natively and through the proxy.
//
//   /perf/page/<name>      test/pages/perf-<name>.html with __CROSS__ set to
//                          the fixture's other origin (localhost for
//                          127.0.0.1 and the other way round), __SELF__ to
//                          the page's own, __PORT__ to the fixture's port
//                          and __RUN__ to the page's `run`
//                          parameter (a name no earlier load used, so no
//                          cache has its resources); `coi=1` isolates it
//                          (COOP same-origin, COEP require-corp)
//   /perf/r?...            one resource:
//     t=js|css|img|font|json|text|html|worker   its type and body
//     n=<name>             a name (and what a script records)
//     tao=<value>          Timing-Allow-Origin (`origin` names the asker)
//     cors=1               Access-Control-Allow-Origin for the asker, with
//                          credentials
//     expose=1             Access-Control-Expose-Headers: Server-Timing
//     st=<value>           Server-Timing
//     enc=gzip|br          Content-Encoding
//     cc=<value>           Cache-Control (no-store without it)
//     etag=<value>         an ETag; a matching If-None-Match gets a 304
//     status=<code>        the status
//     delay=<ms>           answered after ms (at most 3000)
//     to=<url>             a 302 to the URL
//     hint=1               a 103 Early Hints first
//     size=<n>             the body padded to n bytes (js, css, json, text)
//     fill=<text>          what pads it (a text: whole repeats of it, so
//                          multi-byte characters fall on every boundary)
//     chunked=1            no Content-Length (the body goes out chunked)
//     body=<text>          more body (js, css, html), as it is
//     k=<preset>           a body of CSS_PRESETS, whose URLs carry the run
//   /perf/png?w=&h=        a PNG of noise of that size (`tao`, `delay` as
//                          above)
//   /perf/sse              an EventSource stream: one message, then open
//   /perf/beacon           answers a POST with 204
//   /perf/hits?n=<name>    how many requests (and 304s) the name got
//   /perf/ws-echo          the fixture's WebSocket echo
//
// test/fixture.mjs calls `perf(req, res)` and serves the rest.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, crc32, deflateSync, gzipSync } from 'node:zlib';

const pagesDir = fileURLToPath(new URL('./pages/', import.meta.url));

// a 1x1 PNG
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
let font;

const TYPES = {
	js: 'text/javascript; charset=utf-8',
	worker: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	img: 'image/png',
	font: 'font/woff2',
	json: 'application/json',
	text: 'text/plain; charset=utf-8',
	html: 'text/html; charset=utf-8',
};

const hits = new Map();

/** style sheets with subresources; `r` makes a resource URL of the same run */
const CSS_PRESETS = {
	sheet: (r) =>
		`@import url("${r('t=css&n=imported')}");\n` +
		`@font-face { font-family: PerfFont; src: url("${r('t=font&n=font')}") format("woff2"); }\n` +
		`.bg { background-image: url("${r('t=img&n=bg')}"); }\n` +
		`.font { font-family: PerfFont, monospace; }\n`,
	xsheet: (r) => `.xbg { background-image: url("${r('t=img&n=xbg')}"); }\n`,
	late: (r) => `.late { background-image: url("${r('t=img&n=latebg')}"); }\n`,
};

const pad = (text, size, open, close, fill = 'x') => {
	const room = size - Buffer.byteLength(text) - open.length - close.length;
	return room > 0
		? `${text}${open}${fill.repeat(Math.floor(room / Buffer.byteLength(fill)))}${close}`
		: text;
};

function bodyOf(query) {
	const type = query.get('t') ?? 'text';
	const name = query.get('n') ?? '';
	const size = Number(query.get('size')) || 0;
	const run = query.get('run') ?? '';
	const preset = CSS_PRESETS[query.get('k')];
	const extra =
		(preset ? preset((params) => `/perf/r?${params}&run=${run}`) : '') +
		(query.get('body') ?? '');
	switch (type) {
		case 'js':
			return pad(
				`(globalThis.__perfRan ??= []).push(${JSON.stringify(name)});\n${extra}\n`,
				size,
				'/*',
				'*/',
			);
		case 'worker':
			return `${extra}\n`;
		case 'css':
			return pad(
				`${extra}\n.perf-${name} { color: rgb(1, 2, 3); }\n`,
				size,
				'/*',
				'*/',
			);
		case 'img':
			return PNG;
		case 'font':
			return (font ??= readFileSync(`${pagesDir}real-font.woff2`));
		case 'json':
			return pad(JSON.stringify({ name }), size, ' '.repeat(1), '');
		case 'html':
			return `<!doctype html><meta charset="utf-8"><title>${name}</title><body>${extra}`;
		default:
			return pad(`text ${name}`, size, ' ', '', query.get('fill') || 'x');
	}
}

/** true when the request was one of ours and has been answered */
export function perf(req, res) {
	const url = new URL(req.url, 'http://x');
	const path = url.pathname;
	if (!path.startsWith('/perf/')) return false;
	const query = url.searchParams;
	const host = req.headers.host ?? '';
	const port = host.split(':')[1] ?? '';
	const self = `http://${host}`;
	const cross = `http://${host.startsWith('localhost') ? '127.0.0.1' : 'localhost'}:${port}`;

	const page = /^\/perf\/page\/([\w-]+)$/.exec(path)?.[1];
	if (page) {
		let text;
		try {
			text = readFileSync(`${pagesDir}perf-${page}.html`, 'utf8');
		} catch (error) {
			res.statusCode = 404;
			res.end('no such page');
			return true;
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('cache-control', query.get('cc') ?? 'no-store');
		if (query.get('st')) res.setHeader('server-timing', query.get('st'));
		// `coi=1`: the page is cross-origin isolated, and so are the fixture
		// pages it frames (their own URLs do not say so)
		if (query.get('coi') || /[?&]coi=1/.test(req.headers.referer ?? '')) {
			res.setHeader('cross-origin-opener-policy', 'same-origin');
			res.setHeader('cross-origin-embedder-policy', 'require-corp');
			res.setHeader('cross-origin-resource-policy', 'cross-origin');
		}
		if (query.get('hint'))
			res.writeEarlyHints({
				link: '</perf/r?t=css&n=hinted>; rel=preload; as=style',
			});
		const run = (query.get('run') ?? '').replace(/[^\w-]/g, '');
		res.end(
			text
				.replaceAll('__CROSS__', cross)
				.replaceAll('__SELF__', self)
				.replaceAll('__PORT__', port)
				.replaceAll('__RUN__', run),
		);
		return true;
	}
	if (path === '/perf/hits') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('access-control-allow-origin', '*');
		res.end(
			JSON.stringify(
				hits.get(query.get('n')) ?? { requests: 0, notModified: 0 },
			),
		);
		return true;
	}
	if (path === '/perf/sse') {
		res.setHeader('content-type', 'text/event-stream');
		res.setHeader('cache-control', 'no-store');
		res.write('data: one\n\n');
		// left open: the page closes it
		setTimeout(() => res.end(), 5000);
		return true;
	}
	if (path === '/perf/beacon') {
		req.resume();
		req.on('end', () => {
			res.statusCode = 204;
			res.end();
		});
		return true;
	}
	// /perf/png?w=<n>&h=<n>&n=<name>[&tao=][&delay=]: a PNG of noise (an image
	// of one colour is no candidate for the largest contentful paint), the
	// same bytes for the same size
	if (path === '/perf/png') {
		const width = Math.min(Number(query.get('w')) || 120, 400);
		const height = Math.min(Number(query.get('h')) || 80, 400);
		const tao = query.get('tao');
		if (tao) res.setHeader('timing-allow-origin', tao);
		res.setHeader('content-type', 'image/png');
		res.setHeader('cache-control', 'no-store');
		const delay = Math.min(Number(query.get('delay')) || 0, 3000);
		setTimeout(() => res.end(noisePNG(width, height)), delay);
		return true;
	}
	if (path !== '/perf/r') return false;

	const name = query.get('n') ?? '';
	const count = hits.get(name) ?? { requests: 0, notModified: 0 };
	hits.set(name, count);
	count.requests++;

	const origin = req.headers.origin;
	if (query.get('cors')) {
		res.setHeader('access-control-allow-origin', origin ?? '*');
		if (origin) res.setHeader('access-control-allow-credentials', 'true');
		res.setHeader('vary', 'Origin');
		if (req.method === 'OPTIONS') {
			res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
			res.setHeader(
				'access-control-allow-headers',
				req.headers['access-control-request-headers'] ?? 'content-type',
			);
			res.statusCode = 204;
			res.end();
			return true;
		}
	}
	if (query.get('expose'))
		res.setHeader('access-control-expose-headers', 'Server-Timing');
	const tao = query.get('tao');
	if (tao)
		res.setHeader(
			'timing-allow-origin',
			tao === 'origin'
				? (origin ??
						req.headers.referer?.replace(/^(\w+:\/\/[^/]+).*$/, '$1') ??
						'*')
				: tao,
		);
	if (query.get('st')) res.setHeader('server-timing', query.get('st'));
	res.setHeader('cache-control', query.get('cc') ?? 'no-store');

	const answer = () => {
		const to = query.get('to');
		if (to) {
			res.statusCode = 302;
			res.setHeader('location', to);
			res.end();
			return;
		}
		const etag = query.get('etag');
		if (etag) {
			res.setHeader('etag', `"${etag}"`);
			if (req.headers['if-none-match'] === `"${etag}"`) {
				count.notModified++;
				res.statusCode = 304;
				res.end();
				return;
			}
		}
		const type = query.get('t') ?? 'text';
		res.setHeader('content-type', TYPES[type] ?? TYPES.text);
		if (query.get('status')) res.statusCode = Number(query.get('status'));
		let body = Buffer.from(bodyOf(query));
		const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
		if (range) {
			const from = Number(range[1]);
			const to = Math.min(Number(range[2]), body.length - 1);
			res.statusCode = 206;
			res.setHeader('content-range', `bytes ${from}-${to}/${body.length}`);
			body = body.subarray(from, to + 1);
		}
		const encoding = query.get('enc');
		if (encoding === 'gzip') {
			body = gzipSync(body, { level: 9 });
			res.setHeader('content-encoding', 'gzip');
		} else if (encoding === 'br') {
			body = brotliCompressSync(body);
			res.setHeader('content-encoding', 'br');
		}
		// (`chunked`: no Content-Length, as a server that compresses on the
		// fly answers)
		req.resume();
		if (query.get('chunked')) {
			// (written apart from the end, or node counts the bytes itself)
			res.write(body);
			res.end();
			return;
		}
		res.setHeader('content-length', body.length);
		res.end(body);
	};
	const send = () => {
		if (query.get('hint')) {
			res.writeEarlyHints(
				{ link: '</perf/r?t=css&n=hinted>; rel=preload; as=style' },
				() => setTimeout(answer, 30),
			);
			return;
		}
		answer();
	};
	const delay = Math.min(Number(query.get('delay')) || 0, 3000);
	if (delay) setTimeout(send, delay);
	else send();
	return true;
}

const pngs = new Map();
/** a PNG of `width` by `height` pixels of noise, the same every time */
function noisePNG(width, height) {
	const key = `${width}x${height}`;
	const known = pngs.get(key);
	if (known) return known;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let seed = width * 31 + height;
	for (let i = 0; i < raw.length; i++) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		// (the filter byte of each row is 0)
		raw[i] = i % (width * 3 + 1) === 0 ? 0 : seed >>> 16;
	}
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
	pngs.set(key, png);
	return png;
}
