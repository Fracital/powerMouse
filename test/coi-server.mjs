// The cross-origin isolation side of the fixture (cross-origin-isolation
// suite): documents, scripts and resources whose headers the query names,
// and a log of what reached them.
//
//   /coi/doc?h=<name>:<value>&...   a document that runs test/pages/coi.js
//                                   (or `script=<path>`), answered with every
//                                   `h` header; the rest of the query is the
//                                   page's own (which part of the battery)
//   /coi/to?u=<url>&h=...           a 302 to `u`, answered with every `h`
//   /coi/r?k=<key>&h=...&type=...   a resource, logged under k
//     type=png|js|css|text          the body (js: `js=<source>`)
//   /coi/log?k=<key>                what reached /coi/r under k (whether each
//                                   request carried a cookie)
//
// test/fixture.mjs calls `coi(req, res)` first and serves the rest.

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64',
);
const TYPES = {
	png: ['image/png', PNG],
	css: ['text/css', 'body { --coi: 1 }'],
	text: ['text/plain', 'COI-BODY'],
};

const logs = new Map();

function setHeaders(res, query) {
	for (const header of query.getAll('h')) {
		const colon = header.indexOf(':');
		if (colon > 0)
			res.setHeader(header.slice(0, colon), header.slice(colon + 1));
	}
}

/** true when the request was one of ours and has been answered */
export function coi(req, res) {
	const url = new URL(req.url, 'http://x');
	if (!url.pathname.startsWith('/coi/')) return false;
	const query = url.searchParams;
	const key = query.get('k') ?? '';
	res.setHeader('cache-control', 'no-store');
	if (url.pathname === '/coi/doc') {
		setHeaders(res, query);
		res.setHeader('content-type', 'text/html; charset=utf-8');
		const script = query.get('script') ?? '/pages/coi.js';
		res.end(
			`<!doctype html><title>coi</title><body><script src="${script.replace(/[&"<]/g, (c) => `&#${c.charCodeAt(0)};`)}"></script>`,
		);
		return true;
	}
	if (url.pathname === '/coi/log') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('access-control-allow-origin', '*');
		res.end(JSON.stringify({ requests: logs.get(key) ?? [] }));
		return true;
	}
	if (url.pathname === '/coi/to') {
		setHeaders(res, query);
		res.statusCode = 302;
		res.setHeader('location', query.get('u') ?? '/');
		res.end();
		return true;
	}
	if (url.pathname !== '/coi/r') {
		res.statusCode = 404;
		res.end();
		return true;
	}
	const log = logs.get(key) ?? [];
	logs.set(key, log);
	log.push({
		cookie: !!req.headers.cookie,
		mode: req.headers['sec-fetch-mode'] ?? null,
		dest: req.headers['sec-fetch-dest'] ?? null,
	});
	setHeaders(res, query);
	const type = query.get('type') ?? 'text';
	if (type === 'js') {
		res.setHeader('content-type', 'text/javascript');
		res.end(query.get('js') ?? '');
		return true;
	}
	const [mime, body] = TYPES[type] ?? TYPES.text;
	res.setHeader('content-type', mime);
	res.end(body);
	return true;
}
