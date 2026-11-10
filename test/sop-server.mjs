// The same-origin policy side of the fixture (sop-* suites): one resource
// whose CORS, CORP and Timing-Allow-Origin answers the query names, and a
// log of what reached it, so a page can tell a request that was sent from
// one that was refused before it left (a failed preflight).
//
//   /sop/r?k=<key>&...   the resource; every request is logged under k
//     acao, acac=1, aceh, corp, tao     headers of the answer; st=1 adds
//                                       a Server-Timing
//     pacao, pacac=1, pacam, pacah, pmaxage, pstatus
//                                       the answer to a preflight (OPTIONS);
//                                       pacao defaults to acao, pacac to acac
//     type=png|js|mjs|font|text         the body (text: SECRET-BODY)
//     js=<source>                       the script for type=js or mjs
//     redirect=<url>                    a 302 to url, with the headers above
//     status=<n>                        the status of a non-preflight answer
//   /sop/log?k=<key>     what reached /sop/r under k, in order
//
// test/fixture.mjs calls `sop(req, res)` first and serves the rest.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64',
);
const FONT = readFileSync(
	fileURLToPath(new URL('./pages/blank-font.ttf', import.meta.url)),
);
const TYPES = {
	png: ['image/png', PNG],
	font: ['font/ttf', FONT],
	text: ['text/plain', 'SECRET-BODY'],
};

const logs = new Map();

/** true when the request was one of ours and has been answered */
export function sop(req, res) {
	const url = new URL(req.url, 'http://x');
	if (!url.pathname.startsWith('/sop/')) return false;
	const query = url.searchParams;
	const key = query.get('k') ?? '';
	if (url.pathname === '/sop/log') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('access-control-allow-origin', '*');
		res.end(JSON.stringify(logs.get(key) ?? []));
		return true;
	}
	if (url.pathname !== '/sop/r') {
		res.statusCode = 404;
		res.end();
		return true;
	}
	const h = req.headers;
	const log = logs.get(key) ?? [];
	logs.set(key, log);
	log.push({
		method: req.method,
		origin: h.origin ?? null,
		cookie: !!h.cookie,
		mode: h['sec-fetch-mode'] ?? null,
		site: h['sec-fetch-site'] ?? null,
		dest: h['sec-fetch-dest'] ?? null,
		acrm: h['access-control-request-method'] ?? null,
		acrh: h['access-control-request-headers'] ?? null,
		custom: h['x-custom'] ?? null,
	});
	res.setHeader('cache-control', 'no-store');
	const set = (name, value) => {
		if (value !== null && value !== undefined) res.setHeader(name, value);
	};
	if (req.method === 'OPTIONS') {
		set('access-control-allow-origin', query.get('pacao') ?? query.get('acao'));
		if ((query.get('pacac') ?? query.get('acac')) === '1')
			set('access-control-allow-credentials', 'true');
		set('access-control-allow-methods', query.get('pacam'));
		set('access-control-allow-headers', query.get('pacah'));
		set('access-control-max-age', query.get('pmaxage'));
		res.statusCode = Number(query.get('pstatus') ?? 204);
		res.end();
		return true;
	}
	set('access-control-allow-origin', query.get('acao'));
	if (query.get('acac') === '1')
		set('access-control-allow-credentials', 'true');
	set('access-control-expose-headers', query.get('aceh'));
	set('cross-origin-resource-policy', query.get('corp'));
	set('timing-allow-origin', query.get('tao'));
	if (query.get('st')) set('server-timing', 'db;dur=5, cache;desc="hit"');
	res.setHeader('x-secret', 'S');
	const redirect = query.get('redirect');
	if (redirect) {
		res.statusCode = 302;
		res.setHeader('location', redirect);
		res.end();
		return true;
	}
	res.statusCode = Number(query.get('status') ?? 200);
	const type = query.get('type') ?? 'text';
	if (type === 'js' || type === 'mjs') {
		res.setHeader('content-type', 'text/javascript');
		res.end(query.get('js') ?? '');
		return true;
	}
	const [mime, body] = TYPES[type] ?? TYPES.text;
	res.setHeader('content-type', mime);
	res.end(body);
	return true;
}
