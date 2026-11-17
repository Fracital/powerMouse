// A response's `Link` header reads back as the server sent it. The worker
// rewrote the URLs of every response's Link header so the preloads it
// announces go through the proxy, and fetch() and XHR read the routed URLs
// (and lost an `integrity` parameter) where Chrome hands the server's value.
// Chrome acts on a Link header only for a document's own response, which no
// page can read the headers of; so a document keeps the rewrite and every
// other response the server's value. A page here reads Link headers of every
// shape (preload, modulepreload, preconnect, several links with integrity)
// through fetch(), XHR and a fetch of a document a frame loaded, and loads a
// script, a stylesheet, an image and a frame whose responses each announce a
// preload: what the page reads and which of the announced preloads the
// server is asked for are compared natively and through the proxy, both demo
// modes.
import { createServer } from 'node:http';
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

// the Link header of each fetched response, by path
const LINKS = {
	'/res-preload': '</pre/fetch.js>; rel=preload; as=script',
	'/res-module': '</pre/mod.mjs>; rel=modulepreload',
	'/res-style':
		'<https://cdn.invalid/a.css>; rel=preload; as=style; integrity="sha384-AbCd"',
	'/res-many':
		'</pre/x.woff2>; rel=preload; as=font; crossorigin, ' +
		'<https://other.invalid>; rel=preconnect, ' +
		'</pre/y.js>; rel=preload; as=script; integrity="sha256-Q2xBNsH"',
	'/res-xhr': '</pre/xhr.js>; rel=preload; as=script',
	'/doc': '</pre/doc.js>; rel=preload; as=script',
	'/sub.js': '</pre/sub-script.js>; rel=preload; as=script',
	'/sub.css': '</pre/sub-style.js>; rel=preload; as=script',
	'/sub.png': '</pre/sub-image.js>; rel=preload; as=script',
};
// the other URL headers Chrome acts on for no such response: a Location
// that is not a redirect's, and a Content-Location
const URL_HEADERS = {
	'/res-created': { status: 201, headers: { location: '/made/1' } },
	'/res-located': {
		status: 200,
		headers: { location: 'https://elsewhere.invalid/x?y=1' },
	},
	'/res-content-location': {
		status: 200,
		headers: { 'content-location': '/canonical?a=1' },
	},
};

// a 1x1 PNG
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
	'base64',
);

const page = `<!doctype html><title>LINK READBACK</title>
<link rel=stylesheet href=/sub.css><img src=/sub.png><script src=/sub.js></script>
<script>
(async () => {
	const report = { fetch: {}, xhr: {} };
	for (const path of ${JSON.stringify(Object.keys(LINKS).filter((path) => path.startsWith('/res-') && path !== '/res-xhr'))}) {
		const response = await fetch(path);
		report.fetch[path] = response.headers.get('link');
		await response.text();
	}
	report.url = {};
	for (const path of ${JSON.stringify(Object.keys(URL_HEADERS))}) {
		const response = await fetch(path);
		report.url[path] = [response.status, response.headers.get('location'), response.headers.get('content-location')];
		await response.text();
	}
	const xhr = new XMLHttpRequest();
	xhr.open('GET', '/res-xhr');
	await new Promise((resolve) => {
		xhr.onloadend = resolve;
		xhr.send();
	});
	report.xhr.get = xhr.getResponseHeader('link');
	report.xhr.all = (xhr.getAllResponseHeaders().match(/^link: .*$/im) || [null])[0];
	// the document a frame loaded (kept by the cache), fetched again
	const frame = document.createElement('iframe');
	frame.src = '/doc';
	await new Promise((resolve) => {
		frame.onload = resolve;
		document.body.append(frame);
	});
	report.frame = frame.contentDocument.title;
	const again = await fetch('/doc');
	report.fetch['/doc'] = again.headers.get('link');
	await again.text();
	report.done = true;
	window.__linkReport = report;
})();
</script>`;

let asked = new Set();
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname.startsWith('/pre/')) {
		asked.add(url.pathname);
		res.writeHead(200, { 'content-type': 'text/javascript' });
		res.end('');
		return;
	}
	const named = URL_HEADERS[url.pathname];
	if (named) {
		res.writeHead(named.status, {
			...named.headers,
			'content-type': 'text/plain',
		});
		res.end('ok');
		return;
	}
	const link = LINKS[url.pathname];
	const headers = link ? { link } : {};
	if (url.pathname === '/page') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(page);
	} else if (url.pathname === '/doc') {
		res.writeHead(200, {
			...headers,
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'max-age=600',
		});
		res.end('<!doctype html><title>DOC</title>');
	} else if (url.pathname === '/sub.js') {
		res.writeHead(200, { ...headers, 'content-type': 'text/javascript' });
		res.end('window.__sub = 1;');
	} else if (url.pathname === '/sub.css') {
		res.writeHead(200, { ...headers, 'content-type': 'text/css' });
		res.end('p{color:red}');
	} else if (url.pathname === '/sub.png') {
		res.writeHead(200, { ...headers, 'content-type': 'image/png' });
		res.end(PNG);
	} else if (link) {
		res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
		res.end('ok');
	} else {
		res.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/page`;

async function reportOf(page) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__linkReport)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}
// a preload Chrome makes can come after the page reported
const settle = () => sleep(1500);
const show = (value) => JSON.stringify(value);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(url);
const native = await reportOf(nativePage);
await settle();
const nativeAsked = [...asked].sort();
await nativePage.close();
ok('natively, the page reported', native?.done, show(native));
ok(
	'natively, fetch() reads each Link header as the server sent it',
	Object.entries(native?.fetch ?? {}).every(
		([path, value]) => value === LINKS[path],
	),
	show(native?.fetch),
);
ok(
	'natively, fetch() reads a Location and a Content-Location as the server sent them',
	Object.entries(URL_HEADERS).every(
		([path, { status, headers }]) =>
			show(native?.url[path]) ===
			show([
				status,
				headers.location ?? null,
				headers['content-location'] ?? null,
			]),
	),
	show(native?.url),
);
ok(
	'natively, a document preloads what its Link header announces',
	nativeAsked.includes('/pre/doc.js'),
	show(nativeAsked),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	asked = new Set();
	const demo = await openDemo(browser, base);
	await submitLanding(demo, url);
	const proxied = await reportOf(demo);
	await settle();
	const proxiedAsked = [...asked].sort();
	ok(`${mode}: the page reported`, proxied?.done, show(proxied));
	for (const path of Object.keys(native?.fetch ?? {}))
		ok(
			`${mode}: fetch() reads ${path}'s Link header as natively`,
			proxied?.fetch[path] === native.fetch[path],
			show({ native: native.fetch[path], proxied: proxied?.fetch[path] }),
		);
	for (const path of Object.keys(URL_HEADERS))
		ok(
			`${mode}: fetch() reads ${path}'s Location and Content-Location as natively`,
			show(proxied?.url[path]) === show(native?.url[path]),
			show({ native: native?.url[path], proxied: proxied?.url[path] }),
		);
	ok(
		`${mode}: XHR's getResponseHeader reads the Link header as natively`,
		proxied?.xhr.get === native?.xhr.get,
		show({ native: native?.xhr.get, proxied: proxied?.xhr.get }),
	);
	ok(
		`${mode}: XHR's getAllResponseHeaders reads the Link header as natively`,
		proxied?.xhr.all === native?.xhr.all,
		show({ native: native?.xhr.all, proxied: proxied?.xhr.all }),
	);
	ok(
		`${mode}: the frame's document loaded`,
		proxied?.frame === native?.frame,
		show({ native: native?.frame, proxied: proxied?.frame }),
	);
	ok(
		`${mode}: the server is asked for the preloads it is asked for natively`,
		show(proxiedAsked) === show(nativeAsked),
		show({ native: nativeAsked, proxied: proxiedAsked }),
	);
	await demo.close();
}
server.close();
await done(browser);
