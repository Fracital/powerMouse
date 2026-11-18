// The web-platform-tests side of the fixture: serves test/wpt/ at the WPT
// paths the tests hard-code (every directory vendored there: /resources/,
// /common/, /cookies/, /fetch/, /referrer-policy/, ...) and ports the few
// wptserve features they need.
//
// - `.sub.` files (and `?pipe=sub`) get the template substitutions wptserve
//   would do, with our two host names standing in for the WPT domains:
//   {{host}} is localhost, the same-site hosts are www.localhost, the
//   cross-site hosts are 127.0.0.1, every port is the fixture's and https
//   collapses to http (localhost is a secure context, so the
//   trustworthy-origin tests still mean something).
// - `<file>.headers` and `<file>.sub.headers` sidecars (WPT's format, one
//   `Name: value` per line) are sent with the file, after the directory's
//   `__dir__.headers`.
// - `<name>.any.html`, `.any.worker.html`, `.any.sharedworker.html`,
//   `.window.html` and `.worker.html` wrap the matching .js the way wptserve
//   does, honouring its `// META:` lines.
// - `?pipe=` runs wptserve's `header`, `status`, `sub`, `slice`, `gzip` and
//   `trickle` pipes over a file (trickle as one delay before the body).
// - `.asis` files are written to the socket as they are.
// - The python handlers the vendored tests call are small functions in
//   HANDLERS, keyed by the .py path. The ones of the first three suites are
//   below; every other area keeps its own in test/wpt-handlers/<area>.mjs
//   (see `tools` for what such a module is handed).
// - The report script (test/wpt/resources/testharnessreport.js) posts each
//   page's results to /_wpt/report; a suite reads them from /_wpt/results.
// - Each fixture keeps its own reports and stash, and its own copy of the
//   handlers (fixtureOf): test/run.mjs starts one fixture per suite in one
//   process, and a suite's /_wpt/reset empties its own alone.
//
// test/fixture.mjs calls `wpt(req, res, port)` first and serves the rest,
// and hands a WebSocket upgrade to `wptUpgrade` first.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('./wpt/', import.meta.url));
// ours, not WPT directories: the expected-failure lists and what
// refresh.mjs copies
const NOT_SERVED = new Set(['expected', 'lists']);
const PREFIXES = readdirSync(root)
	.filter(
		(name) => !NOT_SERVED.has(name) && statSync(root + name).isDirectory(),
	)
	.map((name) => `/${name}/`);
const TYPES = {
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	xhtml: 'application/xhtml+xml',
	xht: 'application/xhtml+xml',
	xml: 'text/xml',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json',
	svg: 'image/svg+xml',
	png: 'image/png',
	gif: 'image/gif',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	ico: 'image/x-icon',
	webp: 'image/webp',
	bmp: 'image/bmp',
	txt: 'text/plain; charset=utf-8',
	md: 'text/plain; charset=utf-8',
	wasm: 'application/wasm',
	mp4: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	oga: 'audio/ogg',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	manifest: 'text/cache-manifest',
	webmanifest: 'application/manifest+json',
};

export const SAME_ORIGIN_HOST = 'localhost';
export const SAME_SITE_HOST = 'www.localhost';
export const CROSS_SITE_HOST = '127.0.0.1';

const md5 = (text) => createHash('md5').update(text).digest('hex');

/** wptserve's `{{domains[<name>]}}` / `{{hosts[<set>][<name>]}}`, by subdomain */
function domain(name, alt) {
	if (alt) return CROSS_SITE_HOST;
	if (name === '') return SAME_ORIGIN_HOST;
	if (name === 'www') return SAME_SITE_HOST;
	if (name === 'www1') return CROSS_SITE_HOST;
	if (/^www2(\.www)?$/.test(name)) return `www2.${SAME_ORIGIN_HOST}`;
	// the IDN ones: more subdomains of localhost
	return `${name}.${SAME_ORIGIN_HOST}`;
}

function substitute(text, req, port) {
	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const query = url.searchParams;
	const location = {
		server: url.origin,
		scheme: 'http',
		host: url.host,
		hostname: url.hostname,
		port: String(port),
		path: url.pathname + url.search,
		pathname: url.pathname,
		query: url.search,
	};
	// `{{$id:uuid()}}` names a value that `{{$id}}` repeats
	const named = new Map();
	return text
		.replace(/https:\/\/(?=\{\{)/g, 'http://')
		.replace(/wss:\/\/(?=\{\{)/g, 'ws://')
		.replace(/\{\{\$(\w+):uuid\(\)\}\}/g, (_, name) => {
			named.set(name, randomUUID());
			return named.get(name);
		})
		.replace(/\{\{\$(\w+)\}\}/g, (all, name) => named.get(name) ?? all)
		.replace(/\{\{host\}\}/g, SAME_ORIGIN_HOST)
		.replace(/\{\{domains\[([^\]]*)\]\}\}/g, (_, name) => domain(name, false))
		.replace(/\{\{hosts\[(\w*)\]\[([^\]]*)\]\}\}/g, (_, set, name) =>
			domain(name, set === 'alt'),
		)
		.replace(/\{\{ports\[[\w-]+\]\[\d\]\}\}/g, String(port))
		.replace(/\{\{uuid\(\)\}\}/g, () => randomUUID())
		.replace(/\{\{url_base\}\}/g, '/')
		.replace(/\{\{location\[(\w+)\]\}\}/g, (all, part) => location[part] ?? all)
		.replace(/\{\{GET\[([\w-]+)\]\}\}/g, (_, name) => query.get(name) ?? '')
		.replace(
			/\{\{headers\[([\w-]+)\]\}\}/g,
			(_, name) => req.headers[name.toLowerCase()] ?? '',
		)
		.replace(
			/\{\{header_or_default\(([\w-]+), ?([^)]*)\)\}\}/g,
			(_, name, fallback) => req.headers[name.toLowerCase()] ?? fallback,
		);
}

/** WPT's `.headers` sidecar format: one `Name: value` per line */
function sidecarHeaders(file, req, port) {
	const headers = [];
	const dir = `${file.slice(0, file.lastIndexOf('/') + 1)}__dir__`;
	for (const sidecar of [
		`${dir}.headers`,
		`${dir}.sub.headers`,
		`${file}.headers`,
		`${file}.sub.headers`,
	]) {
		if (!existsSync(sidecar)) continue;
		let text = readFileSync(sidecar, 'utf8');
		if (sidecar.endsWith('.sub.headers')) text = substitute(text, req, port);
		for (const line of text.split('\n')) {
			const colon = line.indexOf(':');
			if (colon > 0)
				headers.push([
					line.slice(0, colon).trim(),
					line.slice(colon + 1).trim(),
				]);
		}
	}
	return headers;
}

function setHeaders(res, headers) {
	const grouped = new Map();
	for (const [name, value] of headers) {
		const key = name.toLowerCase();
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key).push(value);
	}
	for (const [name, values] of grouped)
		res.setHeader(name, values.length === 1 ? values[0] : values);
}

/** a test script's `// META: key=value` lines, in order */
export const metaOf = (source) =>
	[...source.matchAll(/^\/\/ META: *(\w+)=(.*)$/gm)].map(([, key, value]) => [
		key,
		value.trim(),
	]);

const GLOBAL = (worker) => `self.GLOBAL = {
  isWindow: function() { return ${!worker}; },
  isWorker: function() { return ${worker}; },
  isShadowRealm: function() { return false; },
};`;

// the wrappers wptserve generates (tools/serve/serve.py), by the suffix of
// the URL asked for: the suffix of the file behind it, and the document
const WRAPPERS = [
	{
		suffix: '.any.html',
		file: '.any.js',
		body: (script, meta) => [
			`<script>\n${GLOBAL(false)}\n</script>`,
			'<script src="/resources/testharness.js"></script>',
			'<script src="/resources/testharnessreport.js"></script>',
			...meta
				.filter(([key]) => key === 'script')
				.map(
					([, value]) =>
						`<script src="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></script>`,
				),
			'<div id=log></div>',
			`<script src="${script}"></script>`,
		],
	},
	{
		suffix: '.window.html',
		file: '.window.js',
		body: (script, meta) => [
			'<script src="/resources/testharness.js"></script>',
			'<script src="/resources/testharnessreport.js"></script>',
			...meta
				.filter(([key]) => key === 'script')
				.map(
					([, value]) =>
						`<script src="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></script>`,
				),
			'<div id=log></div>',
			`<script src="${script}"></script>`,
		],
	},
	...[
		['.any.worker.html', '.any.js', '.any.worker.js', 'Worker'],
		['.any.sharedworker.html', '.any.js', '.any.worker.js', 'SharedWorker'],
		['.worker.html', '.worker.js', '.worker.js', 'Worker'],
	].map(([suffix, file, loaded, kind]) => ({
		suffix,
		file,
		body: (script, meta, query) => [
			'<script src="/resources/testharness.js"></script>',
			'<script src="/resources/testharnessreport.js"></script>',
			'<div id=log></div>',
			'<script>',
			`fetch_tests_from_worker(new ${kind}("${script.slice(0, -file.length)}${loaded}${query}"));`,
			'</script>',
		],
	})),
];

/** the document wptserve generates for a wrapped test, null when `path` is none */
function wrapper(path, query) {
	for (const { suffix, file, body } of WRAPPERS) {
		if (!path.endsWith(suffix)) continue;
		const script = path.slice(0, -suffix.length) + file;
		if (!existsSync(root + script.slice(1))) continue;
		const meta = metaOf(readFileSync(root + script.slice(1), 'utf8'));
		const title = meta.find(([key]) => key === 'title')?.[1] ?? script;
		const text = [
			'<!doctype html>',
			'<meta charset=utf-8>',
			`<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>`,
			...meta
				.filter(([key]) => key === 'timeout')
				.map(([, value]) => `<meta name="timeout" content="${value}">`),
			...body(script, meta, query),
		].join('\n');
		return { script, text };
	}
	return null;
}

/** the script wptserve generates for `<name>.any.worker.js`: the .any.js in a worker */
function workerWrapper(path) {
	if (!path.endsWith('.any.worker.js')) return null;
	const script = `${path.slice(0, -'.any.worker.js'.length)}.any.js`;
	if (!existsSync(root + script.slice(1))) return null;
	const meta = metaOf(readFileSync(root + script.slice(1), 'utf8'));
	const quoted = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const text = [
		...meta
			.filter(([key]) => key === 'title')
			.map(([, value]) => `self.META_TITLE = "${quoted(value)}";`),
		GLOBAL(true),
		'importScripts("/resources/testharness.js");',
		...meta
			.filter(([key]) => key === 'script')
			.map(([, value]) => `importScripts("${quoted(value)}")`),
		`importScripts("${script}");`,
		'done();',
		'',
	].join('\n');
	return { script, text };
}

/**
 * wptserve's pipes (`?pipe=header(a,b)|status(404)`), applied to a file's
 * response: returns what is left to send. `trickle` is its delays only, as
 * one wait before the body.
 */
async function pipes(spec, req, port, response) {
	for (const [, name, args] of spec.matchAll(
		/(\w+)(?:\(((?:\\.|[^)])*)\))?/g,
	)) {
		const list = (args ?? '')
			.split(/(?<!\\),/)
			.map((arg) => arg.replace(/\\(.)/g, '$1').trim());
		if (name === 'header') {
			if (list[2] !== 'True' && list[2] !== 'true')
				response.headers = response.headers.filter(
					([key]) => key.toLowerCase() !== list[0].toLowerCase(),
				);
			response.headers.push([list[0], list[1] ?? '']);
		} else if (name === 'status') response.status = Number(list[0]) || 200;
		else if (name === 'sub')
			response.body = substitute(
				Buffer.from(response.body).toString('utf8'),
				req,
				port,
			);
		else if (name === 'slice') {
			const body = Buffer.from(response.body);
			response.body = body.subarray(
				list[0] && list[0] !== 'null' ? Number(list[0]) : 0,
				list[1] && list[1] !== 'null' ? Number(list[1]) : body.length,
			);
		} else if (name === 'gzip') {
			response.body = gzipSync(Buffer.from(response.body));
			response.headers.push(['Content-Encoding', 'gzip']);
		} else if (name === 'trickle') {
			let wait = 0;
			for (const part of (args ?? '').split(':'))
				if (part.startsWith('d')) wait += Number(part.slice(1)) || 0;
			await new Promise((resolve) => setTimeout(resolve, wait * 1000));
		}
	}
	return response;
}

const cors = (req) => [
	['Access-Control-Allow-Origin', req.headers.origin || '*'],
	['Access-Control-Allow-Credentials', 'true'],
	['Cache-Control', 'no-cache'],
];

/** the request's cookies as [name, value] pairs, in header order */
const cookiePairs = (req) =>
	(req.headers.cookie || '')
		.split(';')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const eq = part.indexOf('=');
			return eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
		});

/**
 * A response written straight to the socket: the cookie tests send
 * Set-Cookie values with control characters on purpose, and Node's
 * setHeader refuses those, so this path keeps the bytes the test asked for.
 */
function raw(res, status, headers, body) {
	const lines = [`HTTP/1.1 ${status} ${status === 302 ? 'Found' : 'OK'}`];
	for (const [name, value] of headers) lines.push(`${name}: ${value}`);
	lines.push('Connection: close', `Content-Length: ${Buffer.byteLength(body)}`);
	res.socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`, 'latin1');
	res.socket.end();
	res.detachSocket(res.socket);
}

const json = (res, status, headers, body) => {
	const all = [['Content-Type', 'application/json'], ...headers];
	try {
		setHeaders(res, all);
	} catch (error) {
		if (error.code !== 'ERR_INVALID_CHAR') throw error;
		for (const name of res.getHeaderNames()) res.removeHeader(name);
		return raw(res, status, all, body);
	}
	res.statusCode = status;
	res.end(body);
};

function readBody(req) {
	return new Promise((resolve) => {
		let body = '';
		// (decoded as a stream: a character split between two chunks, in a
		// report of thousands of subtest names, is still one character)
		req.setEncoding('utf8');
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => resolve(body));
	});
}

/** the request body as it arrived, for a handler that echoes bytes */
function readBodyBytes(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

/**
 * common/security-features/subresource/subresource.py: redirections, the
 * stash actions, then a payload carrying the request headers as JSON.
 */
async function subresource(req, res, url, { type, payload }, stash) {
	const query = url.searchParams;
	const redirection = query.get('redirection');
	if (redirection && redirection !== 'no-redirect') {
		const target = new URL(url);
		target.searchParams.delete('redirection');
		if (redirection === 'swap-origin')
			target.hostname =
				target.hostname === CROSS_SITE_HOST
					? SAME_ORIGIN_HOST
					: CROSS_SITE_HOST;
		// keep-origin, keep-scheme and swap-scheme (https collapses to http)
		// redirect to the same place
		res.statusCode = 301;
		setHeaders(res, [
			['access-control-allow-origin', '*'],
			['location', target.href],
		]);
		return res.end();
	}
	const action = query.get('action');
	if (action) {
		const key = `${query.get('path') || url.pathname}|${query.get('key')}`;
		if (action === 'put') {
			stash.set(key, query.get('value'));
			res.statusCode = 200;
			setHeaders(res, [
				['content-type', 'text/javascript'],
				['cache-control', 'no-cache; must-revalidate'],
			]);
			return res.end(
				JSON.stringify({ status: 'success', result: query.get('key') }),
			);
		}
		if (action === 'take') {
			const value = stash.get(key);
			stash.delete(key);
			res.statusCode = 200;
			setHeaders(res, [
				['content-type', 'text/javascript'],
				['cache-control', 'no-cache; must-revalidate'],
			]);
			return res.end(
				JSON.stringify({
					status:
						value === 'upgraded'
							? 'upgraded'
							: value === undefined
								? 'allowed'
								: 'blocked',
					result: value ?? null,
				}),
			);
		}
		// purge (and check-scheme, which never upgrades over http)
		if (action === 'purge') stash.delete(key);
	}
	const headers = {};
	for (const [name, value] of Object.entries(req.headers))
		headers[name] = value;
	const serverData = { headers: JSON.stringify(headers, null, 4) };
	res.statusCode = 200;
	setHeaders(res, [
		['access-control-allow-origin', '*'],
		['content-type', type],
		['cache-control', 'no-cache; must-revalidate'],
	]);
	res.end(payload(serverData, url, req, stash));
}

/**
 * image.py: the JSON payload encoded as a 24-bit BMP, one byte per three
 * pixels with a bit per channel, which common.sub.js reads back from a canvas.
 */
function bmp(text) {
	const bytes = Buffer.from(text, 'utf8');
	const pixels = [];
	for (const byte of bytes) {
		const bit = (i) => ((byte >> (7 - i)) & 1) * 255;
		pixels.push(
			[bit(0), bit(1), bit(2)],
			[bit(3), bit(4), bit(5)],
			[bit(6), bit(7), 0],
		);
	}
	const side = Math.ceil(Math.sqrt(pixels.length));
	const rowBytes = side * 3;
	const pad = (4 - (rowBytes % 4)) % 4;
	const size = 54 + (rowBytes + pad) * side;
	const out = Buffer.alloc(size);
	out.write('BM', 0);
	out.writeUInt32LE(size, 2);
	out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14);
	out.writeUInt32LE(side, 18);
	out.writeUInt32LE(side, 22);
	out.writeUInt16LE(1, 26);
	out.writeUInt16LE(24, 28);
	let offset = 54;
	// rows are stored bottom-up, pixels as BGR
	for (let row = side - 1; row >= 0; row--) {
		for (let col = 0; col < side; col++) {
			const [r, g, b] = pixels[row * side + col] || [0, 0, 0];
			out[offset++] = b;
			out[offset++] = g;
			out[offset++] = r;
		}
		offset += pad;
	}
	return out;
}

const SUBRESOURCE = {
	'xhr.py': {
		type: 'application/json',
		payload: ({ headers }) => `{"headers": ${headers}}`,
	},
	'empty.py': { type: 'text/plain', payload: () => '' },
	'script.py': {
		type: 'application/javascript',
		payload: ({ headers }) =>
			`postMessage({\n  "headers": ${headers}\n}, "*");`,
	},
	'worker.py': {
		type: 'application/javascript',
		payload: ({ headers }) => `postMessage({\n  "headers": ${headers}\n});`,
	},
	'static-import.py': {
		type: 'application/javascript',
		payload: (_, url) => `import '${url.searchParams.get('import_url')}';`,
	},
	'document.py': {
		type: 'text/html',
		payload: ({ headers }) =>
			`<!DOCTYPE html>
<html>
  <head>
    <title>This page reports back it's request details to the parent frame</title>
  </head>
  <body>
    <script>
      var result = {
        location: document.location.toString(),
        referrer: document.referrer.length > 0 ? document.referrer : undefined,
        headers: ${headers}
      };
      parent.postMessage(result, "*");
    </script>
  </body>
</html>`,
	},
	'image.py': {
		type: 'image/bmp',
		payload: ({ headers }, url, req, stash) => {
			const data = `{"headers": ${headers}}`;
			const id = url.searchParams.get('id');
			if (id) stash.set(`image|${id}`, data);
			return bmp(data);
		},
	},
};

/** the wptserve python handlers the vendored tests call, by path */
const HANDLERS = {
	// cookies/resources/cookie.py: Set-Cookie from ?set=<json string or list>
	// and an optional redirect
	'/cookies/resources/cookie.py': (req, res, url) => {
		const headers = cors(req);
		headers.push(['Expires', 'Fri, 01 Jan 1990 00:00:00 GMT']);
		if (url.searchParams.has('set')) {
			const cookie = JSON.parse(url.searchParams.get('set'));
			for (const value of Array.isArray(cookie) ? cookie : [cookie])
				headers.push(['Set-Cookie', value]);
		}
		if (url.searchParams.has('location')) {
			headers.push(['Location', url.searchParams.get('location')]);
			return json(res, 302, headers, '{"redirect": true}');
		}
		json(res, 200, headers, '{"success": true}');
	},
	'/cookies/resources/set-cookie.py': (req, res, url) => {
		const q = url.searchParams;
		let cookie = `${q.get('name')}=1; Path=${q.get('path')}; Expires=09 Jun ${
			new Date().getFullYear() + 1
		} 10:18:14 GMT`;
		if (q.get('samesite')) cookie += `;SameSite=${q.get('samesite')}`;
		if (q.has('secure')) cookie += ';Secure';
		const headers = [['Set-Cookie', cookie]];
		if (req.headers.origin && req.headers.origin !== 'null')
			headers.push(
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		json(res, 200, headers, "var dummy='value';");
	},
	// set.py: the raw query string is the Set-Cookie value
	'/cookies/resources/set.py': (req, res, url) => {
		json(
			res,
			200,
			[...cors(req), ['Set-Cookie', decodeURIComponent(url.search.slice(1))]],
			'{"success": true}',
		);
	},
	'/cookies/resources/drop.py': (req, res, url) => {
		const name = (url.searchParams.get('name') || '').trim();
		if (!name)
			return json(
				res,
				500,
				cors(req),
				'{"error" : "Empty or missing name parameter."}',
			);
		json(
			res,
			200,
			[...cors(req), ['Set-Cookie', `${name}=; max-age=0; path=/`]],
			'{"success": true}',
		);
	},
	'/cookies/resources/list.py': (req, res) => {
		json(
			res,
			200,
			cors(req),
			JSON.stringify(Object.fromEntries(cookiePairs(req))),
		);
	},
	'/cookies/resources/echo-json.py': (req, res) => {
		const headers = [['Access-Control-Allow-Credentials', 'true']];
		if (req.headers.origin)
			headers.push(['Access-Control-Allow-Origin', req.headers.origin]);
		json(
			res,
			200,
			headers,
			`{ ${cookiePairs(req)
				.map(([k, v]) => `"${k}": "${v}"`)
				.join(',')} }`,
		);
	},
	// fetch/metadata/resources/record-headers.py: the first request with a
	// key stores its headers, `retrieve` takes them (204 while none)
	'/fetch/metadata/resources/record-headers.py': async (
		req,
		res,
		url,
		port,
	) => {
		const { stash } = fixtureOf(port);
		const q = url.searchParams;
		if (q.has('requireOPTIONS') && req.method !== 'OPTIONS') {
			res.statusCode = 200;
			return res.end();
		}
		const body = new URLSearchParams(
			req.method === 'POST' ? await readBody(req) : '',
		);
		const key = md5(q.get('key') ?? body.get('key') ?? '');
		if (q.has('retrieve')) {
			const recorded = stash.get(`headers|${key}`);
			if (recorded === undefined) {
				res.statusCode = 204;
				return res.end();
			}
			stash.delete(`headers|${key}`);
			res.statusCode = 200;
			return res.end(recorded);
		}
		// wptserve hands every header over as a list of values
		if (!stash.has(`headers|${key}`))
			stash.set(`headers|${key}`, JSON.stringify(req.headersDistinct));
		res.statusCode = 200;
		setHeaders(res, [
			['Access-Control-Allow-Origin', '*'],
			['Cache-Control', 'no-cache, no-store, must-revalidate'],
			['Pragma', 'no-cache'],
			['Expires', '0'],
		]);
		if (q.has('mime')) res.setHeader('Content-Type', q.get('mime'));
		res.end(q.get('body') ?? body.get('body') ?? '');
	},
	'/fetch/metadata/resources/echo-as-json.py': (req, res) => {
		const headers = [['Access-Control-Allow-Credentials', 'true']];
		if (req.headers.origin)
			headers.push(['Access-Control-Allow-Origin', req.headers.origin]);
		if (req.method === 'OPTIONS') {
			if (req.headers['sec-fetch-mode'] !== 'cors') {
				res.statusCode = 403;
				return res.end();
			}
			headers.push(
				['Access-Control-Allow-Methods', '*'],
				['Access-Control-Allow-Headers', '*'],
			);
			return json(res, 200, headers, '');
		}
		json(
			res,
			200,
			headers,
			JSON.stringify({
				dest: req.headers['sec-fetch-dest'] ?? '',
				mode: req.headers['sec-fetch-mode'] ?? '',
				site: req.headers['sec-fetch-site'] ?? '',
				user: req.headers['sec-fetch-user'] ?? '',
			}),
		);
	},
	'/fetch/api/resources/redirect.py': (req, res, url) => {
		res.statusCode = Number(url.searchParams.get('status')) || 302;
		const headers = [['Location', url.searchParams.get('location') || '/']];
		if (url.searchParams.has('enable-cors') && req.headers.origin)
			headers.push(
				['Content-Type', 'text/plain'],
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		setHeaders(res, headers);
		res.end();
	},
	'/referrer-policy/generic/resources/referrer.py': (req, res) => {
		res.statusCode = 200;
		setHeaders(res, [
			['Access-Control-Allow-Origin', '*'],
			['Content-Type', 'text/html'],
		]);
		res.end(`
    <p id=referrer>${req.headers.referer ?? ''}</p>
    <script>
      const referrer_text = referrer.textContent;
      window.parent.postMessage(referrer_text, "*");
    </script>
    `);
	},
	'/referrer-policy/generic/resources/refresh-policy.py': (req, res, url) => {
		const target = url.searchParams.get('url') || '';
		const headers = [
			['Content-Type', 'text/html'],
			['Referrer-Policy', url.searchParams.get('policy') || ''],
		];
		if (target) headers.push(['Refresh', `0; url=${target}`]);
		res.statusCode = 200;
		setHeaders(res, headers);
		res.end(
			`<!doctype html>${target ? `Refreshing to ${target}` : 'Not refreshing'}`,
		);
	},
};
for (const [name, spec] of Object.entries(SUBRESOURCE))
	HANDLERS[`/common/security-features/subresource/${name}`] = (
		req,
		res,
		url,
		port,
	) =>
		url.searchParams.has('report-headers') && name === 'image.py'
			? json(
					res,
					200,
					[['Access-Control-Allow-Origin', '*']],
					fixtureOf(port).stash.get(`image|${url.searchParams.get('id')}`) ??
						'',
				)
			: subresource(req, res, url, spec, fixtureOf(port).stash);

// What a module of test/wpt-handlers/ is handed: its default export is a
// function of these that returns `{ handlers, patterns, upgrades, patches }`,
// called once for each fixture with that fixture's `stash` (fixtureOf).
// `handlers` are keyed by the .py path like HANDLERS and called with (req,
// res, url, port); `patterns` are [RegExp, handler] pairs for the paths no
// exact key names; `upgrades` are WebSocket endpoints by path, called with
// (req, socket, head, url, port); `patches` are [from, to] text replacements
// by the path of a vendored file, applied as it is served (after the
// substitutions), for a constant that names something the fixture has not
// (an https origin, a second port).
const tools = {
	root,
	md5,
	cors,
	json,
	raw,
	setHeaders,
	readBody,
	readBodyBytes,
	substitute,
	cookiePairs,
	hosts: { SAME_ORIGIN_HOST, SAME_SITE_HOST, CROSS_SITE_HOST },
};
const PATCHES = {
	// common.sub.js builds the https origins from these constants; the
	// fixture only speaks http
	'/common/security-features/resources/common.sub.js': [
		['const httpsProtocol = "https";', 'const httpsProtocol = "http";'],
		['const wssProtocol = "wss";', 'const wssProtocol = "ws";'],
	],
};
const handlerDir = new URL('./wpt-handlers/', import.meta.url);
/** the default exports of test/wpt-handlers/, in name order */
const AREAS = [];
if (existsSync(handlerDir))
	for (const name of readdirSync(handlerDir).sort())
		if (name.endsWith('.mjs'))
			AREAS.push((await import(new URL(name, handlerDir))).default);

/**
 * What the fixture on `port` keeps, its own as each wptserve's is: the
 * testharness reports, latest per test path (/_wpt/results reads them),
 * wptserve's stash (a value put once and taken once), and the handlers of
 * test/wpt-handlers/ made with that stash, whose own state (counters, open
 * connections) is the fixture's too. test/run.mjs starts one fixture per
 * suite in one process: with one stash for all of them, the /_wpt/reset a
 * suite sends between its native and its proxied run emptied every suite's,
 * and a page of another suite running beside it lost what its requests had
 * stashed (wpt-fetch-objects' request-cache pages, beside
 * wpt-fetch-metadata, read 0 or 1 of their 2 requests).
 */
const fixtures = new Map();
function fixtureOf(port) {
	let fixture = fixtures.get(port);
	if (fixture) return fixture;
	const stash = new Map();
	fixture = {
		reports: new Map(),
		stash,
		handlers: { ...HANDLERS },
		patterns: [],
		upgrades: {},
		patches: { ...PATCHES },
	};
	for (const make of AREAS) {
		const area = make({ ...tools, stash });
		Object.assign(fixture.handlers, area.handlers);
		fixture.patterns.push(...(area.patterns ?? []));
		Object.assign(fixture.upgrades, area.upgrades);
		for (const [path, list] of Object.entries(area.patches ?? {}))
			fixture.patches[path] = [...(fixture.patches[path] ?? []), ...list];
	}
	fixtures.set(port, fixture);
	return fixture;
}

/** a WebSocket upgrade for one of the WPT endpoints; false when it is none */
export function wptUpgrade(req, socket, head, port) {
	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const upgrade = fixtureOf(port).upgrades[url.pathname];
	if (!upgrade) return false;
	upgrade(req, socket, head, url, port);
	return true;
}

/** the key a page's report is kept under: its path and query */
const reportKey = (path, search) => path + (search || '');

/**
 * Serve a WPT request; returns false when the path is not one of ours.
 * `port` is the fixture's own port, for the template substitutions.
 */
export async function wpt(req, res, port) {
	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const path = url.pathname;
	const { reports, stash, handlers, patterns, patches } = fixtureOf(port);
	if (path === '/_wpt/report' && req.method === 'POST') {
		try {
			const body = JSON.parse(await readBody(req));
			reports.set(reportKey(body.path, body.search), body);
			json(res, 200, cors(req), '{"ok": true}');
		} catch (error) {
			json(res, 400, cors(req), JSON.stringify({ error: String(error) }));
		}
		return true;
	}
	if (path === '/_wpt/results') {
		// `path` is the test as the suite names it, query included. A test
		// without variants may have changed its own query on the way
		// (`anyquery`): the report of that path under any query is its
		let key = url.searchParams.get('path');
		if (!reports.has(key) && url.searchParams.has('anyquery'))
			key =
				[...reports.keys()].find(
					(known) => known.split('?')[0] === key.split('?')[0],
				) ?? key;
		const report = reports.get(key);
		if (url.searchParams.has('take')) reports.delete(key);
		if (!report) {
			res.statusCode = 204;
			res.end();
		} else json(res, 200, [], JSON.stringify(report));
		return true;
	}
	if (path === '/_wpt/reset') {
		reports.clear();
		stash.clear();
		json(res, 200, [], '{"ok": true}');
		return true;
	}
	const handler =
		handlers[path] ?? patterns.find(([pattern]) => pattern.test(path))?.[1];
	if (handler) {
		try {
			await handler(req, res, url, port);
		} catch (error) {
			// a handler bug must not take the fixture down with it
			console.error(`wpt handler ${path}: ${error.stack || error}`);
			if (!res.headersSent) res.statusCode = 500;
			res.end();
		}
		return true;
	}
	if (!PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
	if (path.includes('..')) {
		res.statusCode = 400;
		res.end();
		return true;
	}
	let file;
	try {
		file = root + decodeURIComponent(path.slice(1));
	} catch (error) {
		file = root + path.slice(1);
	}
	// wptserve lists a directory; cookie-test.js reads the cookie off that
	// listing when a redirect lands on one
	if (existsSync(file) && statSync(file).isDirectory()) {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(
			`<!doctype html><title>${path}</title><ul>${readdirSync(file)
				.map((name) => `<li>${name}</li>`)
				.join('')}</ul>`,
		);
		return true;
	}
	const response = { status: 200, headers: [], body: null };
	const wrapped = existsSync(file)
		? null
		: (wrapper(path, url.search) ?? workerWrapper(path));
	if (wrapped !== null) {
		response.headers = [
			['Content-Type', path.endsWith('.js') ? TYPES.js : TYPES.html],
			...sidecarHeaders(root + wrapped.script.slice(1), req, port),
		];
		response.body = wrapped.text;
	} else if (!existsSync(file)) {
		res.statusCode = 404;
		res.setHeader('content-type', 'text/plain');
		res.end(`not vendored: ${path}`);
		return true;
	} else if (path.endsWith('.asis')) {
		// the whole response, status line and headers included
		res.socket.write(readFileSync(file));
		res.socket.end();
		res.detachSocket(res.socket);
		return true;
	} else {
		const ext = path.slice(path.lastIndexOf('.') + 1);
		response.headers = [
			['Content-Type', TYPES[ext] || 'application/octet-stream'],
			...sidecarHeaders(file, req, port),
		];
		response.body = readFileSync(file);
		if (path.includes('.sub.') || patches[path]) {
			let text = response.body.toString('utf8');
			if (path.includes('.sub.')) text = substitute(text, req, port);
			for (const [from, to] of patches[path] ?? [])
				text = text.replaceAll(from, to);
			response.body = text;
		}
	}
	if (url.searchParams.has('pipe'))
		await pipes(url.searchParams.get('pipe'), req, port, response);
	res.statusCode = response.status;
	try {
		setHeaders(res, response.headers);
	} catch (error) {
		// a header value node refuses (a control character a test asked for)
		if (error.code !== 'ERR_INVALID_CHAR') throw error;
		for (const name of res.getHeaderNames()) res.removeHeader(name);
		raw(
			res,
			response.status,
			response.headers,
			Buffer.from(response.body).toString('latin1'),
		);
		return true;
	}
	res.end(response.body);
	return true;
}
