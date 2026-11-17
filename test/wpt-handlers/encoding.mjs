// The wptserve pieces the vendored encoding/ tests need
// (test/wpt/lists/encoding.mjs).
import { existsSync, readFileSync, statSync } from 'node:fs';

// wptserve's Content-Type for a file: no charset parameter, which is the
// point of these tests (the document's encoding comes from a byte order
// mark, its `.headers` sidecar or its own <meta>, never from a default the
// server adds)
const TYPES = {
	html: 'text/html',
	htm: 'text/html',
	xml: 'application/xml',
	js: 'text/javascript',
};

export default ({ root, setHeaders }) => {
	const text = (res, type, body) => {
		res.statusCode = 200;
		setHeaders(res, [['Content-Type', type]]);
		res.end(body);
	};
	/** a `.headers` sidecar's lines; one that names a Content-Type replaces ours */
	const sidecar = (file) => {
		const headers = [];
		for (const name of [
			`${file.slice(0, file.lastIndexOf('/') + 1)}__dir__.headers`,
			`${file}.headers`,
		]) {
			if (!existsSync(name)) continue;
			for (const line of readFileSync(name, 'utf8').split('\n')) {
				const colon = line.indexOf(':');
				if (colon > 0)
					headers.push([
						line.slice(0, colon).trim(),
						line.slice(colon + 1).trim(),
					]);
			}
		}
		return headers;
	};
	const fileOf = (path) => {
		const dot = path.lastIndexOf('.');
		if (path.includes('..') || !TYPES[path.slice(dot + 1)]) return null;
		const file = root + path.slice(1);
		return existsSync(file) && statSync(file).isFile() ? file : null;
	};
	return {
		handlers: {
			// the 255 bytes 0x00 to 0xFE under the charset label asked for
			'/encoding/resources/single-byte-raw.py': (req, res, url) =>
				text(
					res,
					`text/plain;charset=${url.searchParams.get('label')}`,
					Buffer.from(Array.from({ length: 255 }, (_, i) => i)),
				),
			'/encoding/resources/text-plain-charset.py': (req, res, url) =>
				text(
					res,
					`text/plain;charset=${url.searchParams.get('label')}`,
					'hello encoding',
				),
			'/encoding/resources/text-html-meta-charset.py': (req, res, url) =>
				text(
					res,
					'text/html',
					`<meta charset="${url.searchParams.get('label')}">hello encoding`,
				),
			// a JSON document under any type and charset asked for: always UTF-8
			'/encoding/resources/json-charset.py': (req, res, url) => {
				const charset = url.searchParams.get('charset');
				res.statusCode = 200;
				setHeaders(res, [
					[
						'Content-Type',
						(url.searchParams.get('type') ?? 'application/json') +
							(charset === null ? '' : `;charset=${charset}`),
					],
					['X-Content-Type-Options', 'nosniff'],
				]);
				res.end(Buffer.from('{"text":"☃é"}', 'utf8'));
			},
		},
		patterns: [
			// the files themselves, typed as wptserve types them (the wrapped
			// .any.js and .window.js pages are not files and stay the server's)
			[
				{ test: (path) => path.startsWith('/encoding/') && !!fileOf(path) },
				(req, res, url) => {
					const file = fileOf(url.pathname);
					const headers = sidecar(file);
					if (!headers.some(([name]) => name.toLowerCase() === 'content-type'))
						headers.unshift([
							'Content-Type',
							TYPES[file.slice(file.lastIndexOf('.') + 1)],
						]);
					res.statusCode = 200;
					setHeaders(res, headers);
					res.end(readFileSync(file));
				},
			],
		],
	};
};
