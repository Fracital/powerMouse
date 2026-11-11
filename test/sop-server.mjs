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
//     type=png|js|mjs|font|text|webm|wav|css|raw
//                                       the body (text: SECRET-BODY; webm: a
//                                       two-second video with a tone; wav:
//                                       the tone)
//     js=<source>                       the script for type=js or mjs
//     css=<source>                      the stylesheet for type=css
//     ct=<type>&body=<text>             the content type and body for type=raw
//     nosniff=1                         X-Content-Type-Options: nosniff
//     long=1                            for type=wav, thirty seconds of the
//                                       tone (over 64 KiB)
//     hold=1                            half the body is sent and the answer
//                                       left open for 20 s (a load that is
//                                       not over)
//     redirect=<url>                    a 302 to url, with the headers above
//     status=<n>                        the status of a non-preflight answer
//     cookie=<value>                    a Set-Cookie of the answer
//     cc=<value>                        its Cache-Control (default no-store)
//   /sop/log?k=<key>     what reached /sop/r under k, in order
//   /sop/cookies         the names of the cookies the request carried
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
const page = (name) =>
	readFileSync(fileURLToPath(new URL(`./pages/${name}`, import.meta.url)));
const TYPES = {
	png: ['image/png', PNG],
	font: ['font/ttf', FONT],
	text: ['text/plain', 'SECRET-BODY'],
	webm: ['video/webm', page('sop-video.webm')],
	wav: ['audio/wav', page('sop-tone.wav')],
};
// thirty seconds of the tone, made here: a sound over 64 KiB, and long
// enough to play while half of it has yet to come
const LONG_WAV = (() => {
	const rate = 22050;
	const samples = rate * 30;
	const wav = Buffer.alloc(44 + samples * 2);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + samples * 2, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(samples * 2, 40);
	for (let i = 0; i < samples; i++)
		wav.writeInt16LE(
			Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
			44 + i * 2,
		);
	return wav;
})();

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
	if (url.pathname === '/sop/cookies') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('cache-control', 'no-store');
		const header = req.headers.cookie ?? '';
		res.end(
			JSON.stringify(
				header ? header.split('; ').map((pair) => pair.split('=')[0]) : [],
			),
		);
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
	res.setHeader('cache-control', query.get('cc') ?? 'no-store');
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
	set('set-cookie', query.get('cookie'));
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
	if (query.get('nosniff')) res.setHeader('x-content-type-options', 'nosniff');
	if (type === 'css') {
		res.setHeader('content-type', 'text/css');
		res.end(query.get('css') ?? '');
		return true;
	}
	if (type === 'raw') {
		res.setHeader('content-type', query.get('ct') ?? 'text/plain');
		res.end(query.get('body') ?? '');
		return true;
	}
	const [mime, short] = TYPES[type] ?? TYPES.text;
	const body = type === 'wav' && query.get('long') ? LONG_WAV : short;
	res.setHeader('content-type', mime);
	if (query.get('hold')) {
		// the first half of the body, and an answer that is not over for a
		// while (a stream that is still loading)
		res.setHeader('content-length', body.length);
		res.write(body.subarray(0, body.length >> 1));
		setTimeout(() => res.destroy(), 20000).unref();
		return true;
	}
	res.end(body);
	return true;
}
