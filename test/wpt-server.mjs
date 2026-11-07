// The web-platform-tests side of the fixture: serves test/wpt/ at the WPT
// paths the tests hard-code (/resources/, /common/, /cookies/, /fetch/,
// /referrer-policy/) and ports the few wptserve features they need.
//
// - `.sub.` files get the template substitutions wptserve would do, with
//   our two host names standing in for the WPT domains: {{host}} is
//   localhost, the same-site hosts are www.localhost, the cross-site hosts
//   are 127.0.0.1, every port is the fixture's and https collapses to http
//   (localhost is a secure context, so the trustworthy-origin tests still
//   mean something).
// - `<file>.headers` and `<file>.sub.headers` sidecars (WPT's format, one
//   `Name: value` per line) are sent with the file.
// - `<name>.any.html` and `<name>.window.html` wrap the matching .js the way
//   wptserve does, honouring its `// META:` lines.
// - The python handlers the vendored tests call are small functions in
//   HANDLERS, keyed by the .py path.
// - The report script (test/wpt/resources/testharnessreport.js) posts each
//   page's results to /_wpt/report; a suite reads them from /_wpt/results.
//
// test/fixture.mjs calls `wpt(req, res, port)` first and serves the rest.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./wpt/', import.meta.url));
const PREFIXES = [
	'/resources/',
	'/common/',
	'/cookies/',
	'/fetch/',
	'/referrer-policy/',
];
const TYPES = {
	html: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json',
	svg: 'image/svg+xml',
	png: 'image/png',
	txt: 'text/plain; charset=utf-8',
	md: 'text/plain; charset=utf-8',
};

export const SAME_ORIGIN_HOST = 'localhost';
export const SAME_SITE_HOST = 'www.localhost';
export const CROSS_SITE_HOST = '127.0.0.1';

/** the testharness reports, latest per test path; /_wpt/results reads them */
const reports = new Map();
/** wptserve's stash: a value put once and taken once */
const stash = new Map();

const md5 = (text) => createHash('md5').update(text).digest('hex');

function substitute(text, req, port) {
	const query = new URL(req.url, 'http://x').searchParams;
	return text
		.replace(/https:\/\/(?=\{\{)/g, 'http://')
		.replace(/wss:\/\/(?=\{\{)/g, 'ws://')
		.replace(/\{\{host\}\}/g, SAME_ORIGIN_HOST)
		.replace(/\{\{(domains\[www\]|hosts\[\]\[www\])\}\}/g, SAME_SITE_HOST)
		.replace(/\{\{domains\[www2(\.www)?\]\}\}/g, `www2.${SAME_ORIGIN_HOST}`)
		.replace(
			/\{\{(domains\[www1\]|hosts\[alt\]\[[\w.]*\])\}\}/g,
			CROSS_SITE_HOST,
		)
		.replace(/\{\{ports\[[\w-]+\]\[\d\]\}\}/g, String(port))
		.replace(/\{\{uuid\(\)\}\}/g, () => randomUUID())
		.replace(/\{\{GET\[(\w+)\]\}\}/g, (_, name) => query.get(name) ?? '')
		.replace(
			/\{\{header_or_default\((\w+), ?([^)]*)\)\}\}/g,
			(_, name, fallback) => req.headers[name.toLowerCase()] ?? fallback,
		);
}

/** WPT's `.headers` sidecar format: one `Name: value` per line */
function sidecarHeaders(file, req, port) {
	const headers = [];
	for (const suffix of ['.headers', '.sub.headers']) {
		if (!existsSync(file + suffix)) continue;
		let text = readFileSync(file + suffix, 'utf8');
		if (suffix === '.sub.headers') text = substitute(text, req, port);
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

/** the wrapper wptserve generates for a .any.js / .window.js test */
function wrapper(script, source) {
	const meta = [...source.matchAll(/^\/\/ META: (\w+)=(.*)$/gm)];
	const title = meta.find(([, k]) => k === 'title')?.[2] ?? script;
	const lines = [
		'<!doctype html>',
		'<meta charset=utf-8>',
		`<title>${title.replace(/</g, '&lt;')}</title>`,
	];
	for (const [, key, value] of meta)
		if (key === 'timeout')
			lines.push(`<meta name="timeout" content="${value}">`);
	lines.push(
		'<script src="/resources/testharness.js"></script>',
		'<script src="/resources/testharnessreport.js"></script>',
	);
	for (const [, key, value] of meta)
		if (key === 'script') lines.push(`<script src="${value}"></script>`);
	lines.push('<div id=log></div>', `<script src="${script}"></script>`);
	return lines.join('\n');
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
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => resolve(body));
	});
}

/**
 * common/security-features/subresource/subresource.py: redirections, the
 * stash actions, then a payload carrying the request headers as JSON.
 */
async function subresource(req, res, url, { type, payload }) {
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
	res.end(payload(serverData, url, req));
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
		payload: ({ headers }, url) => {
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
	'/fetch/metadata/resources/record-headers.py': async (req, res, url) => {
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
	) =>
		url.searchParams.has('report-headers') && name === 'image.py'
			? json(
					res,
					200,
					[['Access-Control-Allow-Origin', '*']],
					stash.get(`image|${url.searchParams.get('id')}`) ?? '',
				)
			: subresource(req, res, url, spec);

/**
 * Serve a WPT request; returns false when the path is not one of ours.
 * `port` is the fixture's own port, for the template substitutions.
 */
export async function wpt(req, res, port) {
	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const path = url.pathname;
	if (path === '/_wpt/report' && req.method === 'POST') {
		try {
			const body = JSON.parse(await readBody(req));
			reports.set(body.path, body);
			json(res, 200, cors(req), '{"ok": true}');
		} catch (error) {
			json(res, 400, cors(req), JSON.stringify({ error: String(error) }));
		}
		return true;
	}
	if (path === '/_wpt/results') {
		const key = url.searchParams.get('path');
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
	if (!PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
	if (HANDLERS[path]) {
		try {
			await HANDLERS[path](req, res, url);
		} catch (error) {
			// a handler bug must not take the fixture down with it
			console.error(`wpt handler ${path}: ${error.stack || error}`);
			if (!res.headersSent) res.statusCode = 500;
			res.end();
		}
		return true;
	}
	if (path.includes('..')) {
		res.statusCode = 400;
		res.end();
		return true;
	}
	const file = root + path.slice(1);
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
	const wrapped = /\.(any|window)\.html$/.exec(path);
	if (wrapped && !existsSync(file)) {
		const script = path.replace(/\.html$/, '.js');
		if (!existsSync(root + script.slice(1))) return false;
		res.statusCode = 200;
		res.setHeader('content-type', TYPES.html);
		res.end(wrapper(script, readFileSync(root + script.slice(1), 'utf8')));
		return true;
	}
	if (!existsSync(file)) {
		res.statusCode = 404;
		res.setHeader('content-type', 'text/plain');
		res.end(`not vendored: ${path}`);
		return true;
	}
	const ext = path.slice(path.lastIndexOf('.') + 1);
	const headers = [
		['Content-Type', TYPES[ext] || 'application/octet-stream'],
		...sidecarHeaders(file, req, port),
	];
	let body = readFileSync(file);
	if (path.includes('.sub.')) {
		let text = substitute(body.toString('utf8'), req, port);
		// common.sub.js builds the https origins from these constants; the
		// fixture only speaks http
		if (path.endsWith('/common.sub.js'))
			text = text
				.replace(
					'const httpsProtocol = "https";',
					'const httpsProtocol = "http";',
				)
				.replace('const wssProtocol = "wss";', 'const wssProtocol = "ws";');
		body = text;
	}
	res.statusCode = 200;
	setHeaders(res, headers);
	res.end(body);
	return true;
}
