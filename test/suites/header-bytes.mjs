// A response header's bytes past 0x7F reach the page as they do natively.
// Chrome reads a header as a byte string, one code unit per byte, so a
// UTF-8 filename a server sends raw in Content-Disposition, a Location or a
// Set-Cookie value is the page's as its bytes. The transport hands the
// worker that byte string, but Chrome encodes every header of a service
// worker's Response as UTF-8 again, so a page read c3 83 c2 a9 for c3 a9.
// The cookie jar kept a Set-Cookie value as its bytes too and showed them to
// document.cookie and the Cookie Store API a byte a character, where Chrome
// decodes a cookie's bytes as UTF-8. A raw HTTP server sends UTF-8 and
// Latin-1 bytes in X-Bytes, Content-Disposition, Set-Cookie and Location;
// the page reads them through fetch, XMLHttpRequest, document.cookie,
// cookieStore, a redirected frame's location and a download's name, natively
// and through the proxy in both demo modes, and the two are compared.
// Chrome reports a non-ASCII download name as "download" when its locale is
// not UTF-8 (LANG=C, measured on 159), so the two cannot be told apart; the
// browser is started in a UTF-8 locale when the machine has one.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

/** a UTF-8 locale Chrome can name a non-ASCII download in, or null */
function utf8Locale() {
	try {
		const names = execFileSync('locale', ['-a'], { encoding: 'utf8' });
		const have = names.split('\n').map((name) => name.trim());
		return (
			have.find((name) => name === 'C.utf8' || name === 'C.UTF-8') ??
			have.find((name) => /utf-?8/i.test(name)) ??
			null
		);
	} catch {
		return null;
	}
}

const DOWNLOAD_LOCALE = utf8Locale();

/** case -> the raw bytes of its value, as a latin1 string */
const VALUES = {
	utf8: 'caf\xc3\xa9 \xe2\x98\x83',
	latin1: 'caf\xe9',
};

const page = () => `<!doctype html>
<title>HEADER BYTES</title>
<script>
	window.__bytes = { cases: {} };
	const CASES = ${JSON.stringify(Object.keys(VALUES))};
	const hex = (text) =>
		text === null || text === undefined
			? text
			: [...text.split('')]
					.map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
					.join(' ');
	const cookieOf = (name) => {
		const pair = document.cookie
			.split('; ')
			.find((part) => part.startsWith(name + '='));
		return pair === undefined ? null : pair.slice(name.length + 1);
	};
	function xhr(url) {
		return new Promise((resolve) => {
			const request = new XMLHttpRequest();
			request.open('GET', url);
			request.onloadend = () =>
				resolve({
					one: hex(request.getResponseHeader('x-bytes')),
					all: hex(
						(request.getAllResponseHeaders().match(/^x-bytes: (.*)$/m) ??
							[])[1] ?? null,
					),
				});
			request.send();
		});
	}
	function landed(name) {
		return new Promise((resolve) => {
			const frame = document.createElement('iframe');
			const timer = setTimeout(() => resolve('no report'), 15000);
			addEventListener('message', function heard(event) {
				if (event.data?.landed !== name) return;
				removeEventListener('message', heard);
				clearTimeout(timer);
				frame.remove();
				resolve(event.data.href);
			});
			frame.src = '/r/' + name;
			document.body.append(frame);
		});
	}
	addEventListener('load', async () => {
		for (const name of CASES) {
			const result = {};
			try {
				__bytes.at = name + ': fetch';
				const response = await fetch('/h/' + name, { cache: 'no-store' });
				await response.text();
				result.fetch = {
					value: hex(response.headers.get('x-bytes')),
					disposition: hex(response.headers.get('content-disposition')),
					entry: hex(
						[...response.headers].find(([key]) => key === 'x-bytes')?.[1],
					),
				};
				__bytes.at = name + ': xhr';
				result.xhr = await xhr('/h/' + name);
				__bytes.at = name + ': document.cookie';
				result.documentCookie = hex(cookieOf('hb_' + name));
				__bytes.at = name + ': cookieStore';
				result.cookieStore = window.cookieStore
					? hex((await cookieStore.get('hb_' + name))?.value ?? null)
					: 'no cookieStore';
				__bytes.at = name + ': echo';
				result.echo = await (
					await fetch('/echo/' + name, {
						cache: 'no-store',
						headers: { 'x-sent': 'caf\\xc3\\xa9', 'x-latin': 'caf\\xe9' },
					})
				).text();
				__bytes.at = name + ': location';
				result.location = await landed(name);
			} catch (error) {
				result.error = __bytes.at + ': ' + error.name + ': ' + error.message;
			}
			__bytes.cases[name] = result;
		}
		__bytes.jar = hex(document.cookie);
		__bytes.store = window.cookieStore
			? (await cookieStore.getAll()).map((c) => c.name + '=' + hex(c.value))
			: null;
		__bytes.at = 'downloads';
		// a navigation's download (a frame's) and a download attribute's
		for (const name of [...CASES, 'none']) {
			const frame = document.createElement('iframe');
			frame.src = '/d/' + name + '/d' + name;
			document.body.append(frame);
			const link = document.createElement('a');
			link.href = '/a/' + name + '/a' + name;
			link.download = '';
			document.body.append(link);
			link.click();
		}
		__bytes.done = true;
	});
</script>
<body></body>
`;

const landedPage = (name) => `<!doctype html><title>landed</title><script>
	parent.postMessage({ landed: ${JSON.stringify(name)}, href: location.href }, '*');
</script>`;

function respond(socket, status, head, body) {
	const bytes = Buffer.from(body, 'utf8');
	socket.end(
		Buffer.concat([
			Buffer.from(
				`HTTP/1.1 ${status}\r\n` +
					head +
					`Content-Length: ${bytes.length}\r\n` +
					'Cache-Control: no-store\r\nConnection: close\r\n\r\n',
				'latin1',
			),
			bytes,
		]),
	);
}

const hexOf = (text) =>
	[...Buffer.from(text, 'latin1')]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join(' ');
/** a request header's value as the server got it, null for none */
const field = (head, name) => {
	const line = head
		.split('\r\n')
		.find((one) => one.toLowerCase().startsWith(`${name}:`));
	return line === undefined ? null : line.slice(name.length + 1).trim();
};
/** the bytes of the hw cookie, X-Sent and X-Latin the server got, as hex */
const echoed = (head) => {
	const pair = (field(head, 'cookie') ?? '')
		.split('; ')
		.find((part) => part.startsWith('hw='));
	const bytes = (value) => (value === null ? 'none' : hexOf(value));
	return JSON.stringify({
		cookie: bytes(pair === undefined ? null : pair.slice(3)),
		sent: bytes(field(head, 'x-sent')),
		latin: bytes(field(head, 'x-latin')),
	});
};

function handle(socket, head) {
	const path = (head.split(' ')[1] ?? '/').split('?')[0];
	const [, kind, name] = path.match(/^\/(\w+)\/(\w+)/) ?? [];
	const value = VALUES[name];
	if (path === '/page')
		return respond(socket, '200 OK', 'Content-Type: text/html\r\n', page());
	if (kind === 'landed')
		return respond(
			socket,
			'200 OK',
			'Content-Type: text/html\r\n',
			landedPage(name),
		);
	if ((kind === 'd' || kind === 'a') && name === 'none')
		return respond(
			socket,
			'200 OK',
			'Content-Type: application/octet-stream\r\n' +
				'Content-Disposition: attachment\r\n',
			'download:none',
		);
	if (value === undefined) return respond(socket, '404 Not Found', '', 'none');
	if (kind === 'h')
		return respond(
			socket,
			'200 OK',
			'Content-Type: text/plain\r\n' +
				`X-Bytes: ${value}\r\n` +
				`Content-Disposition: inline; filename="h${name}-${value}.txt"\r\n` +
				`Set-Cookie: hb_${name}=${value}; Path=/\r\n` +
				// what a script writes: the server reads it back on /echo
				`Set-Cookie: hw=${value}; Path=/echo/${name}\r\n`,
			'ok',
		);
	if (kind === 'echo')
		return respond(
			socket,
			'200 OK',
			'Content-Type: text/plain\r\n',
			echoed(head),
		);
	if (kind === 'r')
		return respond(
			socket,
			'302 Found',
			`Location: /landed/${name}/${value}?q=${value}\r\n`,
			'',
		);
	if (kind === 'd' || kind === 'a')
		return respond(
			socket,
			'200 OK',
			'Content-Type: application/octet-stream\r\n' +
				`Content-Disposition: attachment; filename="${kind}${name}-${value}.txt"\r\n`,
			`download:${name}`,
		);
	respond(socket, '404 Not Found', '', 'none');
}

function startServer() {
	const server = createServer((socket) => {
		let seen = '';
		socket.on('error', () => {});
		socket.on('data', (chunk) => {
			if (seen === null) return;
			seen += chunk.toString('latin1');
			if (!seen.includes('\r\n\r\n')) return;
			const head = seen;
			seen = null;
			handle(socket, head);
		});
	});
	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

/** the downloads a page started: suggested names, by case */
function collect(page) {
	const names = {};
	page.on('download', (download) => {
		// (a proxied download's URL is a route: the case is in the name,
		// d or a and the case, before the value or as the URL's name)
		const name = download.suggestedFilename();
		names[name.split(/[-.]/)[0]] = name;
	});
	return names;
}

async function reportOf(page, downloads) {
	let last = null;
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__bytes)
				.catch(() => null);
			if (value?.done) {
				// the downloads start once the page has asked for them
				for (let j = 0; j < 40; j++) {
					if (Object.keys(downloads).length >= DOWNLOADS.length) break;
					await sleep(250);
				}
				return { ...value, downloads: { ...downloads } };
			}
			if (value) last = value;
		}
	}
	return { stuck: last?.at ?? 'no report', cases: last?.cases ?? {} };
}

const show = (value) => JSON.stringify(value);
/** the downloads the page starts, by the name each has natively */
const DOWNLOADS = ['d', 'a'].flatMap((kind) =>
	[...Object.keys(VALUES), 'none'].map((name) => kind + name),
);
const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch([], {
	env: DOWNLOAD_LOCALE
		? { LANG: DOWNLOAD_LOCALE, LC_ALL: DOWNLOAD_LOCALE }
		: null,
});

const nativeContext = await browser.newContext({ acceptDownloads: true });
const nativePage = await nativeContext.newPage();
const nativeDownloads = collect(nativePage);
await nativePage.goto(`${origin}/page`);
const native = await reportOf(nativePage, nativeDownloads);
await nativeContext.close();
ok(
	'natively, the page read every case',
	native.done,
	native.done ? '' : show(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const downloads = collect(page);
	await submitLanding(page, `${origin}/page`);
	const proxied = await reportOf(page, downloads);
	ok(
		`${mode}: the page read every case`,
		proxied.done,
		proxied.done ? '' : show(proxied),
	);
	for (const name of Object.keys(VALUES)) {
		const want = native.cases[name] ?? {};
		const got = proxied.cases[name] ?? {};
		for (const reader of ['fetch', 'xhr', 'documentCookie', 'cookieStore'])
			ok(
				`${mode}: ${name}: ${reader} reads what it reads natively`,
				show(got[reader]) === show(want[reader]),
				show({ native: want[reader], proxied: got[reader] }),
			);
		// what goes back to the server: the cookie's bytes, and a field the
		// page sends with UTF-8 bytes. Left out (logged): a field with a
		// byte that is not UTF-8, which Chrome hands a service worker as ""
		// (measured), and a cookie whose bytes are not UTF-8, which a
		// transport that sends text cannot send
		const echo = (report) => {
			try {
				return JSON.parse(report.echo);
			} catch {
				return {};
			}
		};
		const wantEcho = echo(want);
		const gotEcho = echo(got);
		console.log(
			`${mode}: ${name}: echo`,
			show({ native: wantEcho, proxied: gotEcho }),
		);
		ok(
			`${mode}: ${name}: a field the page sends reaches the server as natively`,
			gotEcho.sent === wantEcho.sent && wantEcho.sent !== undefined,
			show({ native: wantEcho.sent, proxied: gotEcho.sent }),
		);
		if (name === 'utf8')
			ok(
				`${mode}: ${name}: the cookie goes back as the bytes the server set`,
				gotEcho.cookie === wantEcho.cookie && wantEcho.cookie !== undefined,
				show({ native: wantEcho.cookie, proxied: gotEcho.cookie }),
			);
		// the route of a redirect is the proxy's: the page's own location
		// shows the site's URL
		ok(
			`${mode}: ${name}: a redirect lands where it lands natively`,
			got.location === want.location,
			show({ native: want.location, proxied: got.location }),
		);
	}
	ok(
		`${mode}: document.cookie and cookieStore read the jar as natively at the end`,
		proxied.jar === native.jar && show(proxied.store) === show(native.store),
		show({
			native: [native.jar, native.store],
			proxied: [proxied.jar, proxied.store],
		}),
	);
	for (const name of DOWNLOADS)
		ok(
			`${mode}: ${name}: a download is named as natively`,
			native.downloads?.[name] !== undefined &&
				proxied.downloads?.[name] === native.downloads[name],
			show({
				native: native.downloads?.[name],
				proxied: proxied.downloads?.[name],
			}),
		);
	await page.close();
}
server.close();
await done(browser);
