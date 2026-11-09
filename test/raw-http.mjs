// Raw HTTP/1.1 fixture: a TCP server that writes response heads byte for
// byte, because node's http server refuses to emit the malformed header
// lines real servers send (a line with no colon, a NUL, a CR alone). Each
// case answers twice: /case/<name> for fetch and /frame/<name> as a frame
// document, with its own cookie names so the two never mask each other.
// /page runs every case and leaves the result in window.__rawHeaders.
//
//   node test/raw-http.mjs [port]     serve on its own (default 8086)
import { createServer } from 'node:net';

/**
 * name -> the header lines of the case, raw (`tag` tells the fetch copy
 * from the frame copy, `x` or `f`). Every case ends in a valid X-After so
 * a check sees whether the lines after the bad one survived.
 */
export const CASES = {
	clean: (tag) => `X-Before: 1\r\nSet-Cookie: rh_clean_${tag}=1; Path=/\r\n`,
	'no-colon': (tag) =>
		`X-Before: 1\r\nThis line has no colon\r\nSet-Cookie: rh_nocolon_${tag}=1; Path=/\r\n`,
	// the shape of WPT cookies/value/value.html "ignore value after LF"
	'lf-no-colon': (tag) => `Set-Cookie: rh_lf_${tag}=13; Path=/\nZYX\r\n`,
	// the shape of WPT cookies/name/name-ctl.html "%x0 in name (HTTP)"
	'nul-value': (tag) =>
		`X-Nul: a\0b\r\nSet-Cookie: rh_nul_${tag}\0name=1; Path=/\r\n`,
	'nul-name': (tag) =>
		`X-Bad\0Name: 1\r\nSet-Cookie: rh_nulname_${tag}=1; Path=/\r\n`,
	'lone-cr': (tag) =>
		`X-Cr: a\rX-Cr-After: b\r\nSet-Cookie: rh_cr_${tag}=1; Path=/\rX-Tail: t\r\n`,
	'space-colon': (tag) => `X-Sp : 1\r\nSet-Cookie: rh_sp_${tag}=1; Path=/\r\n`,
	// obs-fold: Chrome joins the continuation with one space
	'obs-fold': (tag) =>
		`X-Fold: a\r\n b\r\nSet-Cookie: rh_fold_${tag}=1; Path=/\r\n`,
	// obs-text: a header carrying UTF-8 bytes (a Content-Disposition
	// filename, say) is a byte string to the page
	'obs-text': () => 'X-Utf8: caf\xc3\xa9\r\n',
};

const page = () => `<!doctype html>
<title>RAW HEADERS</title>
<script>
	window.__rawHeaders = { cases: {} };
	const NAMES = ${JSON.stringify(Object.keys(CASES))};
	const jar = () => new Set(document.cookie.split('; ').filter(Boolean));
	const added = (before) =>
		[...jar()].filter((cookie) => !before.has(cookie)).sort();
	async function fetched(name) {
		try {
			__rawHeaders.at = name + ': fetch';
			const response = await fetch('/case/' + name, { cache: 'no-store' });
			__rawHeaders.at = name + ': body';
			return {
				status: response.status,
				body: await response.text(),
				headers: [...response.headers]
					.filter(([key]) => key.startsWith('x-'))
					.map(([key, value]) => key + ': ' + value),
			};
		} catch (error) {
			return 'rejected ' + error.name;
		}
	}
	function framed(name) {
		return new Promise((resolve) => {
			const frame = document.createElement('iframe');
			const timer = setTimeout(() => resolve('no load event'), 15000);
			frame.addEventListener('load', () => {
				clearTimeout(timer);
				let text;
				try {
					const body = frame.contentDocument.getElementById('body');
					text = body ? body.textContent : 'other document: ' +
						frame.contentDocument.title;
				} catch (error) {
					text = 'unreadable ' + error.name;
				}
				frame.remove();
				resolve(text);
			});
			__rawHeaders.at = name + ': frame';
			frame.src = '/frame/' + name;
			document.body.append(frame);
		});
	}
	addEventListener('load', async () => {
		for (const name of NAMES) {
			// an error (a document.cookie read the bridge could not answer) is
			// that case's result, and the next case still runs
			try {
				__rawHeaders.at = name + ': cookies';
				const before = jar();
				const result = {
					fetch: await fetched(name),
					frame: await framed(name),
				};
				__rawHeaders.at = name + ': cookies';
				result.cookies = added(before);
				__rawHeaders.cases[name] = result;
			} catch (error) {
				__rawHeaders.cases[name] = {
					error: __rawHeaders.at + ': ' + error.name + ': ' + error.message,
				};
			}
		}
		__rawHeaders.done = true;
	});
</script>
<body></body>
`;

function respond(socket, head, body) {
	const bytes = Buffer.from(body, 'utf8');
	socket.end(
		Buffer.concat([
			Buffer.from(
				'HTTP/1.1 200 OK\r\n' +
					head +
					`Content-Length: ${bytes.length}\r\n` +
					'Cache-Control: no-store\r\nConnection: close\r\n\r\n',
				'latin1',
			),
			bytes,
		]),
	);
}

function handle(socket, path) {
	const [, kind, name] = path.match(/^\/(case|frame)\/([\w-]+)$/) ?? [];
	const lines = CASES[name];
	if (path === '/page')
		return respond(socket, 'Content-Type: text/html\r\n', page());
	if (!lines) return respond(socket, 'Content-Type: text/plain\r\n', 'none');
	if (kind === 'case')
		return respond(
			socket,
			'Content-Type: text/plain\r\n' + lines('x') + 'X-After: 2\r\n',
			`body:${name}`,
		);
	respond(
		socket,
		'Content-Type: text/html\r\n' + lines('f') + 'X-After: 2\r\n',
		`<!doctype html><title>${name}</title><p id="body">frame:${name}</p>`,
	);
}

/** listen on `port` (0 picks one); resolves with the server */
export function startRawHttp(port = 0) {
	const server = createServer((socket) => {
		let seen = '';
		socket.on('error', () => {});
		socket.on('data', (chunk) => {
			if (seen === null) return;
			seen += chunk.toString('latin1');
			if (!seen.includes('\r\n\r\n')) return;
			const path = seen.split(' ')[1] ?? '/';
			seen = null;
			handle(socket, path.split('?')[0]);
		});
	});
	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(process.argv[1].split('/').pop())
) {
	const server = await startRawHttp(Number(process.argv[2] || 8086));
	console.log(`raw http on http://127.0.0.1:${server.address().port}/page`);
}
