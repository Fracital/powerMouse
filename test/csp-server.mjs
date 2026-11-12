// The Content-Security-Policy side of the fixture (csp-* suites): a
// document under the policies its query names, which runs probes and
// records what each did and the violation events it saw.
//
//   /csp/doc?p=<policy>&ro=<policy>&m=<policy>&probes=<a,b>&h=<how>
//     p:  a Content-Security-Policy header (repeatable: one header each)
//     ro: a Content-Security-Policy-Report-Only header (repeatable)
//     m:  a <meta http-equiv="Content-Security-Policy"> in the head
//         (repeatable)
//     probes: the names of test/pages/csp-probes.js's probes to run
//     s:  styles in the head, one carrying nonce="probes" (markup-styles)
//     h:  how the probe script is included, so that the policy lets it
//         run: `self` (a script element whose src is /csp/probes.js, the
//         default), `nonce` (that element with nonce="probes"), `inline`
//         (its text inline), `inline-nonce`, `inline-hash` (inline, and the
//         sha256 of its text is in the X-Probe-Hash header)
//   /csp/probes.js       the probes (test/pages/csp-probes.js)
//   /csp/ok              text "ok", for any origin (CORS *)
//   /csp/run.js          a script that sets window.__ran to 1
//   /csp/sse             an event stream of one message, "sse"
//   /csp/img.png         a 1x1 PNG
//   /csp/worker.js       a worker that posts "worker" back
//   /csp/frame.html      a document that posts "frame" to its parent
//   /csp/font.woff       a font (test/pages/blank-font.ttf)
//   /csp/style.css       a stylesheet that sets --csp-style on :root
//   /csp/sound.wav       a short silent WAV
//   /csp/manifest.json   a web app manifest
//   /csp/to?u=<url>      a 302 to `u`
//   /csp/log?k=<key>     the paths that reached /csp/ under that key
//                        (`k=` on any of them)
//
// test/fixture.mjs calls `csp(req, res)` first and serves the rest.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pages = fileURLToPath(new URL('./pages/', import.meta.url));
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64',
);

/** a short silent mono 8-bit WAV */
export function silentWav(samples = 800) {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + samples, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(8000, 24);
	header.writeUInt32LE(8000, 28);
	header.writeUInt16LE(1, 32);
	header.writeUInt16LE(8, 34);
	header.write('data', 36);
	header.writeUInt32LE(samples, 40);
	return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

const logs = new Map();
const attribute = (value) =>
	value.replace(/[&"<]/g, (c) => `&#${c.charCodeAt(0)};`);

/** true when the request was one of ours and has been answered */
export function csp(req, res) {
	const url = new URL(req.url, 'http://x');
	if (!url.pathname.startsWith('/csp/')) return false;
	const query = url.searchParams;
	const key = query.get('k');
	if (key !== null && url.pathname !== '/csp/log') {
		if (!logs.has(key)) logs.set(key, []);
		logs.get(key).push(url.pathname);
	}
	res.setHeader('cache-control', 'no-store');
	res.setHeader('access-control-allow-origin', '*');
	const send = (type, body) => {
		res.setHeader('content-type', type);
		res.end(body);
	};
	switch (url.pathname) {
		case '/csp/doc': {
			const probes = readFileSync(`${pages}csp-probes.js`, 'utf8');
			for (const policy of query.getAll('p'))
				res.appendHeader('content-security-policy', policy);
			for (const policy of query.getAll('ro'))
				res.appendHeader('content-security-policy-report-only', policy);
			const metas = query
				.getAll('m')
				.map(
					(policy) =>
						`<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">`,
				)
				.join('');
			const how = query.get('h') ?? 'self';
			const text = `\n${probes}\n`;
			if (how === 'inline-hash')
				res.setHeader(
					'x-probe-hash',
					`sha256-${createHash('sha256').update(text).digest('base64')}`,
				);
			const script =
				how === 'self'
					? '<script src="/csp/probes.js"></script>'
					: how === 'nonce'
						? '<script nonce="probes" src="/csp/probes.js"></script>'
						: how === 'inline-nonce'
							? `<script nonce="probes">${text}</script>`
							: `<script>${text}</script>`;
			// `s=1`: styles in the markup, one with the nonce, one without
			const styles = query.has('s')
				? '<style nonce="probes">:root { --csp-markup-nonce: yes; }</style><style>:root { --csp-markup-plain: yes; }</style>'
				: '';
			send(
				'text/html; charset=utf-8',
				`<!doctype html><html><head>${metas}<title>CSP PROBES</title>${styles}</head><body>${script}</body></html>`,
			);
			return true;
		}
		case '/csp/probes.js':
			send(
				'text/javascript; charset=utf-8',
				readFileSync(`${pages}csp-probes.js`),
			);
			return true;
		case '/csp/ok':
			send('text/plain', 'ok');
			return true;
		case '/csp/run.js':
			send('text/javascript', 'window.__ran = 1;');
			return true;
		case '/csp/sse':
			send('text/event-stream', 'data: sse\n\n');
			return true;
		case '/csp/img.png':
			send('image/png', PNG);
			return true;
		case '/csp/worker.js':
			send('text/javascript', 'postMessage("worker");');
			return true;
		case '/csp/frame.html':
			send(
				'text/html; charset=utf-8',
				'<!doctype html><title>csp frame</title><script>parent.postMessage("frame", "*");</script>',
			);
			return true;
		case '/csp/font.woff':
			send('font/ttf', readFileSync(`${pages}blank-font.ttf`));
			return true;
		case '/csp/style.css':
			send('text/css', ':root { --csp-style: loaded; }');
			return true;
		case '/csp/sound.wav':
			send('audio/wav', silentWav());
			return true;
		case '/csp/manifest.json':
			send('application/manifest+json', '{"name":"csp"}');
			return true;
		case '/csp/to':
			res.statusCode = 302;
			res.setHeader('location', query.get('u') ?? '/csp/ok');
			res.end();
			return true;
		case '/csp/log':
			send('application/json', JSON.stringify(logs.get(key) ?? []));
			return true;
	}
	return false;
}
