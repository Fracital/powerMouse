// Fixture site for the suites: pages that try to notice or escape the frame.
// Served on 127.0.0.1, so the demo server needs WISP_ALLOW_LOOPBACK=1 (the
// runner sets it). `node test/fixture.mjs [port]` runs it on its own.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { sop } from './sop-server.mjs';
import { wpt } from './wpt-server.mjs';

// /pages/<file> serves test/pages/<file> as is; a `<file>.headers.json`
// next to it adds response headers (Set-Cookie, a Content-Type charset).
// New fixtures go there, so suites never need to touch this file. The
// web-platform-tests paths (/resources/, /common/, /cookies/, /fetch/,
// /referrer-policy/ and /_wpt/) are served by test/wpt-server.mjs, and
// /sop/ (the same-origin policy suites) by test/sop-server.mjs.
const pagesDir = fileURLToPath(new URL('./pages/', import.meta.url));
const TYPES = {
	html: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json',
};

// a hostile page that records every tell of being framed (isolation suite)
const ESCAPE = `<!doctype html><html><head><title>escape fixture</title></head><body><pre id="result">pending</pre>
<script>
const r = {};
const t = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = 'threw ' + e.name; } };
t('topIsSelf', () => top === window);
t('parentIsSelf', () => parent === window);
t('frameElement', () => frameElement);
t('ancestorOrigins', () => location.ancestorOrigins.length);
t('referrer', () => document.referrer);
t('name', () => window.name);
t('outerSize', () => [outerWidth, outerHeight, screenX, screenY].join(' '));
t('parentDocTitle', () => parent.document.title);
t('topDocTitle', () => top.document.title);
t('topLocationHref', () => top.location.href);
t('postMessageSeen', () => { addEventListener('message', (e) => { r.gotMessage = e.origin; document.getElementById('result').textContent = JSON.stringify(r); }); return 'listening'; });
document.getElementById('result').textContent = JSON.stringify(r);
if (location.search.includes('nav=1')) setTimeout(() => { try { top.location.href = 'https://example.org/'; } catch (e) { r.topNav = 'threw ' + e.name; document.getElementById('result').textContent = JSON.stringify(r); } }, 300);
</script></body></html>`;

// every way a click or a script could leave the frame (escapes suite)
const TARGETS = `<!doctype html><title>FIXTURE</title>
<a id="top" href="/landed?top" target="_top">top</a>
<a id="parent" href="/landed?parent" target="_parent">parent</a>
<a id="blank" href="/landed?blank" target="_blank">blank</a>
<a id="plain" href="/landed?plain">plain</a>
<form id="f" action="/landed?form" target="_top"><button id="fbtn">submit</button></form>
<button id="open">open</button>
<button id="toploc">toploc</button>
<button id="bracket">bracket</button>
<button id="openblank">openblank</button>
<button id="docloc">docloc</button>
<script>
document.getElementById('docloc').onclick = () => { document.location = '/landed?docloc'; };
document.getElementById('openblank').onclick = () => { window.__opened = window.open('/landed?openblank'); };
document.getElementById('open').onclick = () => window.open('/landed?open', '_top');
document.getElementById('toploc').onclick = () => { top.location = '/landed?toploc'; };
document.getElementById('bracket').onclick = () => { const k = 'to' + 'p'; window[k].location.href = '/landed?bracket'; };
</script>`;

// scripts inserted at runtime must run rewritten (dynamic-scripts suite).
// Each records whether it saw the spoofed top and the real URL.
const DYN = `<!doctype html><title>DYN</title><body></body><script>
window.__r_inline = [top === window, location.href];
const code = (k) => 'window.__r_' + k + ' = [top === window, location.href];';
const s1 = document.createElement('script'); s1.textContent = code('textContent'); document.body.append(s1);
const s2 = document.createElement('script'); s2.text = code('text'); document.body.appendChild(s2);
const s3 = document.createElement('script'); s3.appendChild(document.createTextNode(code('textNode'))); document.head.append(s3);
const s4 = document.createElement('script'); s4.innerHTML = code('innerHTML'); document.body.insertBefore(s4, null);
const d = document.createElement('div'); d.innerHTML = '<script>' + code('divInnerHTML') + '<\\/script>'; document.body.append(d);
document.body.insertAdjacentHTML('beforeend', '<script>' + code('insertAdjacentHTML') + '<\\/script>');
(0, eval)(code('indirectEval'));
eval(code('directEval'));
new Function(code('Function'))();
setTimeout(code('stringTimer'), 0);
</script>`;

// JS shapes that the rewriter must leave valid and must still spoof: one
// script per case, so a script the rewriter breaks fails alone (rewriter
// suite). Each case records a boolean on window.__rw.
const REWRITER = `<!doctype html><title>REWRITER</title>
<script type="importmap">{"imports":{"bare":"data:text/javascript,window.__rw.bare = true","bare2":"data:text/javascript,export default 'B2'"}}</script>
<script>window.__rw = {};</script>
<script>class A { top = 1; location = 2; eval = 3 } const a = new A(); __rw.classField = a.top === 1 && a.location === 2 && a.eval === 3;</script>
<script>try { throw 7; } catch (location) { __rw.catchParam = location === 7; }</script>
<script>__rw.classExpr = (class top {}).name === 'top';</script>
<script>top: for (let i = 0; i < 3; i++) { break top; } __rw.label = true;</script>
<script>__rw.typeofTop = typeof top === 'object' && typeof location === 'object' && typeof eval === 'function';</script>
<script>{ const { g: location } = { g: 5 }; __rw.aliasPattern = location === 5; }</script>
<script>{ const { location, top } = window; __rw.shorthandPattern = location.href === window.location.href && top === window; }</script>
<script>const o = { location, top }; __rw.shorthand = o.location.href === location.href && o.top === top;</script>
<script>{ const { a: { top: t } } = { a: window }; __rw.nestedPattern = t === window; }</script>
<script>{ let t; ({ a: { top: t } } = { a: window }); __rw.nestedAssign = t === window; }</script>
<script>{ const { a: { b: { location: l } } } = { a: { b: window } }; __rw.deepPattern = l === location; }</script>
<script>(function ({ top: t }) { __rw.paramPattern = t === window; })(window);</script>
<script>(({ a: { location: l } }) => { __rw.arrowParam = l === location; })({ a: window });</script>
<script>__rw.arrowExprParam = (({ top: t }) => t === window)(window);</script>
<script>(function ({ top: t } = window) { __rw.defaultParam = t === window; })();</script>
<script>({ m({ top: t }, n) { __rw.methodParam = t === window && n === 2; } }).m(window, 2);</script>
<script>(function () { 'use strict'; (function (a, { top: t }, ...rest) { __rw.strictParam = t === window && a === 1 && rest.length === 1 && (function () { return this; })() === undefined; })(1, window, 3); })();</script>
<script type="module">import top from 'data:text/javascript,export default 42'; __rw.importName = top === 42;</script>
<script type="module">import 'bare';</script>
<script type="module">import { a, b } from './mod-re.js'; __rw.reexport = a === 'A' && b === 'A';</script>
<script type="module">__rw.dynBare = (await import('bare2')).default === 'B2';</script>
<script src="/sub/dyn.js"></script>
<script type="module">__rw.metaResolve = import.meta.resolve('./mod-a.js') === new URL('./mod-a.js', location.href).href && import.meta.resolve('bare') === 'bare';</script>
<script type="module">await new Promise((r) => setTimeout(r, 300)); __rw.done = true;</script>`;

const MODULES = {
	'/mod-a.js': "export const a = 'A';",
	// a classic script's dynamic import resolves against the script, not the
	// document (rewriter suite)
	'/sub/mod-a.js': "export const a = 'SUB';",
	'/sub/dyn.js':
		"import('./mod-a.js').then((m) => { __rw.classicImportBase = m.a === 'SUB'; });",
	'/mod-re.js':
		"export * from './mod-a.js'; export { a as b } from './mod-a.js';",
};

const PAGES = {
	'/escape.html': ESCAPE,
	'/': TARGETS,
	'/dyn': DYN,
	'/rewriter': REWRITER,
};

// how often each /pages/ file was requested, and how many of those were
// answered 304 (cache suite); /hits returns the counters
const hits = new Map();
// the body version of each /rewrite-js script, by name
const scriptVersions = new Map();
// every path served, in order (/requests returns it; the assets suite checks
// that no served URL carries the package name)
const served = [];
// request headers kept by key (/echo-headers?k=<key>), for the requests whose
// response a page cannot read back: images, scripts, navigations
const recorded = new Map();
// the dist bundle under neutral names (assets suite): /neutral/<name>
const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const NEUTRAL = {
	'sw.js': 'serviceWorker.js',
	'doc.js': 'injectDocument.js',
	'wk.js': 'injectWorker.js',
	'ctl.js': 'Controller.js',
	'frame.html': 'controllerFrame.html',
	'frame.js': 'controllerFrame.js',
	'tw.js': 'transportWorker.js',
	'rw.js': 'rewriteWorker.js',
};
// the transport modules under neutral names too (assets and transport-worker
// suites): /neutral/transport.mjs is epoxy, /neutral/libcurl.mjs is libcurl
const TRANSPORTS = {
	'transport.mjs': 'epoxy-transport',
	'libcurl.mjs': 'libcurl-transport',
};
const transportFile = (name) =>
	fileURLToPath(
		new URL(
			`../node_modules/@mercuryworkshop/${name}/dist/index.mjs`,
			import.meta.url,
		),
	);

export function startFixture(port = 8084) {
	const server = createServer(async (req, res) => {
		const path = new URL(req.url, 'http://x').pathname;
		if (sop(req, res)) return;
		if (await wpt(req, res, port)) return;
		served.push(path);
		if (path === '/requests') {
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(served));
		}
		const neutral = /^\/neutral\/([\w.-]+)$/.exec(path)?.[1];
		if (neutral) {
			const file = TRANSPORTS[neutral]
				? transportFile(TRANSPORTS[neutral])
				: NEUTRAL[neutral] && `${distDir}${NEUTRAL[neutral]}`;
			if (!file || !existsSync(file)) {
				res.statusCode = 404;
				return res.end('no such neutral asset');
			}
			res.setHeader(
				'content-type',
				neutral.endsWith('.html')
					? 'text/html; charset=utf-8'
					: 'text/javascript; charset=utf-8',
			);
			res.setHeader('cache-control', 'no-cache');
			return res.end(readFileSync(file));
		}
		// how many request bytes arrived (streamed-body measurement)
		if (path === '/echo-body') {
			let bytes = 0;
			req.on('data', (chunk) => (bytes += chunk.length));
			req.on('end', () => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ bytes }));
			});
			return;
		}
		// a script that arrives after `ms` and records `mark` in the order its
		// document runs scripts (blank-loads suite)
		if (path === '/slow-js') {
			const query = new URL(req.url, 'http://x').searchParams;
			res.setHeader('content-type', 'text/javascript');
			setTimeout(
				() =>
					res.end(
						`window.__order.push(${JSON.stringify(query.get('mark') ?? '')});`,
					),
				Math.min(Number(query.get('ms')) || 0, 3000),
			);
			return;
		}
		// a script whose body is the same until /rewrite-js/bump?name=<name>
		// changes it, whatever else the URL carries; `cc=` is its Cache-Control
		// (rewrite-cache and rewrite-pool suites)
		if (path === '/rewrite-js/bump') {
			const name = new URL(req.url, 'http://x').searchParams.get('name');
			scriptVersions.set(name, (scriptVersions.get(name) ?? 0) + 1);
			return res.end('bumped');
		}
		if (path === '/rewrite-js') {
			const query = new URL(req.url, 'http://x').searchParams;
			const version = scriptVersions.get(query.get('name')) ?? 0;
			res.setHeader('content-type', 'text/javascript');
			if (query.get('cc')) res.setHeader('cache-control', query.get('cc'));
			// `three=<n>`: n copies of three.js first, a script that takes a
			// while to rewrite (rewrite-pool suite) or whose output is large
			// (rewrite-cache suite)
			const three = Math.min(Number(query.get('three')) || 0, 8);
			if (three)
				res.write(
					`${readFileSync(`${pagesDir}vendor-three.min.js`, 'utf8')};\n`.repeat(
						three,
					),
				);
			return res.end(
				`(window.__rc ??= []).push([${JSON.stringify(query.get('name'))}, ${version}, location.href.length > 0, typeof window.top]);\n`,
			);
		}
		// a response that takes five seconds (abort measurement)
		if (path === '/slow') {
			setTimeout(() => res.end('slow'), 5000);
			return;
		}
		// /stale/<name>: cache-control with stale directives and a counting
		// body; `sie` answers 500 after its first response (cache-stale suite)
		const stale = /^\/stale\/(swr|swr-short|sie)$/.exec(path)?.[1];
		if (stale) {
			const count = hits.get(`stale/${stale}`) || {
				requests: 0,
				notModified: 0,
			};
			count.requests++;
			hits.set(`stale/${stale}`, count);
			res.setHeader('content-type', 'application/json');
			res.setHeader(
				'cache-control',
				stale === 'swr'
					? 'max-age=1, stale-while-revalidate=60'
					: stale === 'swr-short'
						? 'max-age=1, stale-while-revalidate=1'
						: 'max-age=1, stale-if-error=60',
			);
			if (stale === 'sie' && count.requests > 1) {
				res.statusCode = 500;
				return res.end(JSON.stringify({ error: 'down' }));
			}
			return res.end(JSON.stringify({ n: count.requests }));
		}
		// FedCM's well-known file (fedcm suite): the browser fetches it from
		// the identity provider's site before the config the page names
		// (test/pages/fedcm-config.json)
		if (path === '/.well-known/web-identity') {
			res.setHeader('content-type', 'application/json');
			return res.end(
				JSON.stringify({
					provider_urls: [`http://${req.headers.host}/pages/fedcm-config.json`],
				}),
			);
		}
		if (path === '/hits') {
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(Object.fromEntries(hits)));
		}
		// the request headers the proxy sent, as JSON (headers suites); with
		// `?k=<key>` they are kept for /echo-headers/recorded?k=<key> too, and
		// `&js` answers an empty script instead (a script element's request).
		// Any origin may read it, with credentials too (the CORS answer names
		// the request's Origin and allows credentials)
		if (path === '/echo-headers') {
			const query = new URL(req.url, 'http://x').searchParams;
			if (query.get('k')) recorded.set(query.get('k'), req.headers);
			res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
			if (req.headers.origin)
				res.setHeader('access-control-allow-credentials', 'true');
			if (query.has('js')) {
				res.setHeader('content-type', 'text/javascript');
				return res.end('');
			}
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(req.headers));
		}
		// HTTP Basic auth (xhr-parity suite): /xhr-auth/<case>/<file>?k=<key>
		// answers 401 with a challenge for the case's own realm unless the
		// request carries the credentials `u` and `p`, then 200 with the
		// Authorization it got; `nc` answers 200 without a challenge. Every
		// request's Authorization is kept by key and case for /xhr-auth-log
		const auth = /^\/xhr-auth\/([\w-]+)\//.exec(path)?.[1];
		if (auth) {
			const query = new URL(req.url, 'http://x').searchParams;
			const key = `xhr-auth:${query.get('k')}`;
			const log = recorded.get(key) ?? {};
			recorded.set(key, log);
			(log[auth] ??= []).push(req.headers.authorization ?? null);
			const expected = `Basic ${Buffer.from(`${query.get('u')}:${query.get('p')}`).toString('base64')}`;
			res.setHeader('content-type', 'application/json');
			if (!query.has('nc') && req.headers.authorization !== expected) {
				res.statusCode = 401;
				res.setHeader('www-authenticate', `Basic realm="xhr-${auth}"`);
				return res.end('{"denied":true}');
			}
			return res.end(
				JSON.stringify({ authorization: req.headers.authorization ?? null }),
			);
		}
		if (path === '/xhr-auth-log') {
			const key = new URL(req.url, 'http://x').searchParams.get('k');
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(recorded.get(`xhr-auth:${key}`) ?? {}));
		}
		if (path === '/echo-headers/recorded') {
			const key = new URL(req.url, 'http://x').searchParams.get('k');
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(recorded.get(key) ?? null));
		}
		// /pages/deep/<any dirs>/<file> is test/pages/<file> too: a page under a
		// deeper path, whose relative URLs resolve somewhere other than the
		// directory of its route would (bypass-relative suite)
		const file = /^\/pages\/(?:deep\/(?:[\w.-]+\/)*)?([\w.-]+)$/.exec(
			path,
		)?.[1];
		if (file && existsSync(`${pagesDir}${file}`)) {
			const ext = file.slice(file.lastIndexOf('.') + 1);
			res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
			const sidecar = `${pagesDir}${file}.headers.json`;
			const extra = existsSync(sidecar)
				? JSON.parse(readFileSync(sidecar, 'utf8'))
				: {};
			for (const [name, value] of Object.entries(extra))
				res.setHeader(name, value);
			const count = hits.get(file) || { requests: 0, notModified: 0 };
			count.requests++;
			hits.set(file, count);
			// a file with an ETag answers a matching conditional request with 304
			if (extra.etag && req.headers['if-none-match'] === extra.etag) {
				count.notModified++;
				res.statusCode = 304;
				return res.end();
			}
			// `?base=<url>` puts a <base href> where the page has `<!--BASE-->`;
			// a page that marks its requests (`?rb=`) is a stub when a form
			// without an action submits back to it, so its vectors fire once
			const query = new URL(req.url, 'http://x').searchParams;
			if (ext === 'html' && query.has('rb') && file === 'bypass-relative.html')
				return res.end('<title>LANDED</title><h1>landed</h1>');
			const base = query.get('base');
			if (ext === 'html' && base !== null)
				return res.end(
					readFileSync(`${pagesDir}${file}`, 'utf8').replace(
						'<!--BASE-->',
						`<base href="${base.replace(/[&"<]/g, (c) => `&#${c.charCodeAt(0)};`)}" />`,
					),
				);
			return res.end(readFileSync(`${pagesDir}${file}`));
		}
		if (path in MODULES) {
			res.setHeader('content-type', 'text/javascript; charset=utf-8');
			return res.end(MODULES[path]);
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		if (path.startsWith('/landed'))
			return res.end('<title>LANDED</title><h1>landed</h1>');
		res.end(PAGES[path] ?? '<title>other</title>other');
	});
	// /ws-echo: a WebSocket that sends its handshake's Cookie and Origin
	// headers and its request-target as one message, then closes (ws-cookies
	// suite), with the HTTP version and the header lines as they arrived:
	// case, order and repeats (ws-handshake suite). Any path ending in
	// /ws-echo answers, so a relative socket URL shows where it resolved
	// (bypass-relative suite)
	const sockets = new WebSocketServer({ noServer: true });
	server.on('upgrade', (req, socket, head) => {
		if (!new URL(req.url, 'http://x').pathname.endsWith('/ws-echo'))
			return socket.destroy();
		// `?k=<key>`: the handshake's headers kept, as /echo-headers keeps a
		// request's (request-header-parity suite)
		const key = new URL(req.url, 'http://x').searchParams.get('k');
		if (key) recorded.set(key, req.headers);
		sockets.handleUpgrade(req, socket, head, (ws) => {
			ws.send(
				JSON.stringify({
					cookie: req.headers.cookie || '',
					origin: req.headers.origin || '',
					url: req.url,
					version: req.httpVersion,
					raw: req.rawHeaders,
				}),
			);
			ws.close();
		});
	});
	return new Promise((resolve, reject) => {
		// every interface, so http://localhost:PORT/ (a second proxied origin
		// for the suites) answers over ::1 as well as 127.0.0.1
		server.once('error', reject);
		server.listen(port, () => resolve(server));
	});
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(process.argv[1].split('/').pop())
) {
	const port = Number(process.argv[2] || process.env.FIXTURE_PORT || 8084);
	await startFixture(port);
	console.log(`fixture on http://127.0.0.1:${port}/`);
}
