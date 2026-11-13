// Fixture site for the suites: pages that try to notice or escape the frame.
// Served on 127.0.0.1, so the demo server needs WISP_ALLOW_LOOPBACK=1 (the
// runner sets it). `node test/fixture.mjs [port]` runs it on its own.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { readCases, STRICT } from '../rust/host/early-lib.mjs';
import { coi } from './coi-server.mjs';
import { csp } from './csp-server.mjs';
import { shapes } from './shapes-server.mjs';
import { sop } from './sop-server.mjs';
import { visited } from './visited-server.mjs';
import { wpt } from './wpt-server.mjs';

// /pages/<file> serves test/pages/<file> as is; a `<file>.headers.json`
// next to it adds response headers (Set-Cookie, a Content-Type charset).
// New fixtures go there, so suites never need to touch this file. The
// web-platform-tests paths (/resources/, /common/, /cookies/, /fetch/,
// /referrer-policy/ and /_wpt/) are served by test/wpt-server.mjs,
// /csp/ (the content security policy suites) by test/csp-server.mjs,
// /sop/ (the same-origin policy suites) by test/sop-server.mjs, /visited/
// (the visited suite) by test/visited-server.mjs, /coi/ (the
// cross-origin isolation suite) by test/coi-server.mjs and /shape/ (the
// url-shapes suite) by test/shapes-server.mjs.
const pagesDir = fileURLToPath(new URL('./pages/', import.meta.url));
/** the early-error cases' texts by their line, read at the first request */
let earlyCases;
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
	// the import-map fixture's module targets (importmap suite): a bare
	// specifier maps to one, a trailing-slash prefix to a directory, and a
	// scope overrides a dependency for modules under it
	'/vendor/react.js': "export default 'REACT-DEFAULT'; export const v = 18;",
	// a trailing-slash prefix maps `react-dom/client` here, with no extension,
	// the way a package directory on a CDN serves a subpath
	'/vendor/reactdom/client':
		"export default 'RD-CLIENT'; export const createRoot = () => 'ROOT';",
	'/vendor/dep-global.js': "export default 'DEP-GLOBAL';",
	'/vendor/dep-scoped.js': "export default 'DEP-SCOPED';",
	'/vendor/scoped/host.js': "import dep from 'dep'; export default dep;",
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
// what the http-cache suite's requests asked, by run then by name
const httpCacheLog = new Map();
// the body version of each /rewrite-js script, by name
const scriptVersions = new Map();
// how many /rewrite-js responses said which they were (`st`)
let scriptResponses = 0;
// every path served, in order (/requests returns it; the assets suite checks
// that no served URL carries the package name)
const served = [];
// request headers kept by key (/echo-headers?k=<key>), for the requests whose
// response a page cannot read back: images, scripts, navigations
const recorded = new Map();
// what each step of a FedCM flow saw, by run id `k` (fedcm suite): the mock
// identity provider records the Sec-Fetch-Dest and cookie of each endpoint and
// the token POST's body, so a suite can prove every step went through the proxy
// with the right destination and credentials
const fedcmLog = new Map();
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
	'lib.js': 'rewriterLib.js',
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
// a transport's sibling wasm: the de-inlined epoxy ships epoxy.wasm next to
// index.mjs and fetches it with new URL('epoxy.wasm', import.meta.url), so the
// renamed transport (served as /neutral/transport.mjs) resolves it to
// /neutral/epoxy.wasm, served here from the package's dist (assets,
// blank-loads, sw-restart suites)
const TRANSPORT_SIBLINGS = {
	'epoxy.wasm': 'epoxy-transport',
};
const transportSibling = (name, pkg) =>
	fileURLToPath(
		new URL(
			`../node_modules/@mercuryworkshop/${pkg}/dist/${name}`,
			import.meta.url,
		),
	);

export function startFixture(port = 8084) {
	const server = createServer(async (req, res) => {
		const path = new URL(req.url, 'http://x').pathname;
		if (sop(req, res)) return;
		if (visited(req, res)) return;
		if (coi(req, res)) return;
		if (csp(req, res)) return;
		if (shapes(req, res)) return;
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
				: TRANSPORT_SIBLINGS[neutral]
					? transportSibling(neutral, TRANSPORT_SIBLINGS[neutral])
					: NEUTRAL[neutral] && `${distDir}${NEUTRAL[neutral]}`;
			if (!file || !existsSync(file)) {
				res.statusCode = 404;
				return res.end('no such neutral asset');
			}
			res.setHeader(
				'content-type',
				neutral.endsWith('.html')
					? 'text/html; charset=utf-8'
					: neutral.endsWith('.wasm')
						? 'application/wasm'
						: 'text/javascript; charset=utf-8',
			);
			res.setHeader('cache-control', 'no-cache');
			return res.end(readFileSync(file));
		}
		// a case of rust/host/early-errors.txt by its line, as a script: `f` is
		// `script` (as written), `strict` (behind 'use strict') or `held` (with
		// a last import that throws, so a module that compiles never runs)
		// (early-errors suite)
		if (path === '/early-js') {
			const query = new URL(req.url, 'http://x').searchParams;
			earlyCases ??= new Map(
				readCases()
					.filter((entry) => entry.code !== undefined)
					.map((entry) => [String(entry.line), entry.code]),
			);
			const code = earlyCases.get(query.get('n'));
			if (code === undefined) {
				res.statusCode = 404;
				return res.end('no such case');
			}
			const form = query.get('f');
			res.setHeader('content-type', 'text/javascript; charset=utf-8');
			res.setHeader('cache-control', 'no-store');
			return res.end(
				form === 'strict'
					? STRICT + code
					: form === 'held'
						? `${code}\nimport "data:text/javascript,throw 0";`
						: code,
			);
		}
		// a script served with two Content-Type values, as tiktok's CDN sends
		// for sw.js ("application/javascript, text/javascript"): the fetch
		// Headers object joins them with ", " and Chrome refuses the script's
		// MIME, so the worker must collapse it to one value. `mode=joined`:
		// one header already written as a comma list; otherwise two separate
		// Content-Type headers. `module`: a module body; `-sw.js`: a worker
		// body; else a classic body. Each records that it ran.
		if (path === '/dup-content-type' || path === '/dup-content-type-sw.js') {
			const query = new URL(req.url, 'http://x').searchParams;
			if (query.get('mode') === 'joined')
				res.setHeader(
					'content-type',
					'application/javascript, text/javascript',
				);
			else
				res.setHeader('content-type', [
					'application/javascript',
					'text/javascript',
				]);
			res.setHeader('cache-control', 'no-store');
			res.setHeader('service-worker-allowed', '/');
			return res.end(
				path.endsWith('-sw.js')
					? "self.addEventListener('install', () => self.skipWaiting());"
					: query.has('module')
						? 'globalThis.__dupModule && globalThis.__dupModule();'
						: 'globalThis.__dupClassic = true;',
			);
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
		// Turnstile-shaped POST echo (xhr-post-shapes suite): records exactly
		// what reached the origin for a POST, keyed by `k` and `shape`, so a
		// proxied request can be compared byte-for-byte with the same native
		// one. Reflects the Origin and allows credentials and the custom
		// header, and answers the CORS preflight, so a cross-origin
		// credentialed POST with a non-safelisted content-type goes out.
		// `/echo-post/log?k=<key>` returns the records.
		if (path === '/echo-post' || path === '/echo-post/log') {
			const query = new URL(req.url, 'http://x').searchParams;
			const origin = req.headers.origin;
			if (origin) {
				res.setHeader('access-control-allow-origin', origin);
				res.setHeader('access-control-allow-credentials', 'true');
			} else res.setHeader('access-control-allow-origin', '*');
			res.setHeader('cache-control', 'no-store');
			if (req.method === 'OPTIONS') {
				res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
				res.setHeader(
					'access-control-allow-headers',
					req.headers['access-control-request-headers'] ?? 'content-type',
				);
				res.setHeader('access-control-max-age', '0');
				res.statusCode = 204;
				return res.end();
			}
			if (path === '/echo-post/log') {
				res.setHeader('content-type', 'application/json');
				return res.end(
					JSON.stringify(recorded.get(`post:${query.get('k')}`) ?? null),
				);
			}
			const chunks = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.on('end', () => {
				const body = Buffer.concat(chunks);
				const key = `post:${query.get('k')}`;
				const log = recorded.get(key) ?? {};
				recorded.set(key, log);
				log[query.get('shape') ?? ''] = {
					method: req.method,
					contentType: req.headers['content-type'] ?? null,
					contentLength: req.headers['content-length'] ?? null,
					transferEncoding: req.headers['transfer-encoding'] ?? null,
					origin: req.headers.origin ?? null,
					cookie: req.headers.cookie ?? null,
					custom: req.headers['x-cf-token'] ?? null,
					bodyHex: body.toString('hex'),
					bodyLen: body.length,
				};
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ ok: true }));
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
		// (rewrite-cache, rewrite-pool and wasm-rewriter suites)
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
			// `st`: a Server-Timing metric that says which response this is
			if (query.has('st'))
				res.setHeader('server-timing', `nth;desc="${++scriptResponses}"`);
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
			// `extra=<code>`: written first, as it is (wasm-rewriter suite)
			if (query.get('extra')) res.write(`${query.get('extra')}\n`);
			return res.end(
				`(window.__rc ??= []).push([${JSON.stringify(query.get('name'))}, ${version}, location.href.length > 0, typeof window.top]);\n`,
			);
		}
		// a page whose answer takes `ms` (at most ten seconds): a navigation
		// that is still loading (toolbar suite)
		if (path === '/slow-page') {
			const query = new URL(req.url, 'http://x').searchParams;
			setTimeout(
				() => {
					res.setHeader('content-type', 'text/html; charset=utf-8');
					res.end(`<!doctype html><title>SLOW</title><h1>slow</h1>`);
				},
				Math.min(Number(query.get('ms')) || 0, 10000),
			);
			return;
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
		// FedCM's well-known file (fedcm suite): fetched from the identity
		// provider's site before the config the page names
		if (path === '/.well-known/web-identity') {
			res.setHeader('content-type', 'application/json');
			return res.end(
				JSON.stringify({
					provider_urls: [`http://${req.headers.host}/pages/fedcm-config.json`],
				}),
			);
		}
		// The mock identity provider the fedcm suite flows through. Every FedCM
		// endpoint requires Sec-Fetch-Dest: webidentity (so the suite proves the
		// proxy sends it) and reflects the Origin with credentials allowed (the
		// proxied, page-level emulation reads these cross-origin bodies with CORS,
		// where a real browser reads them no-cors from its own process). `k=<run>`
		// ties a flow's steps together; the config bakes it into the sibling
		// endpoint URLs it returns. `?signin` seeds the IdP session cookie.
		if (path.startsWith('/pages/fedcm-')) {
			const query = new URL(req.url, 'http://x').searchParams;
			const run = query.get('k') ?? '';
			const origin = req.headers.origin;
			if (origin) {
				res.setHeader('access-control-allow-origin', origin);
				res.setHeader('access-control-allow-credentials', 'true');
				res.setHeader('vary', 'origin');
			} else res.setHeader('access-control-allow-origin', '*');
			res.setHeader('cache-control', 'no-store');
			const dest = req.headers['sec-fetch-dest'];
			const record = (step) => {
				const log = fedcmLog.get(run) ?? {};
				fedcmLog.set(run, log);
				log[step] = {
					dest: dest ?? null,
					cookie: req.headers.cookie ?? null,
					mode: req.headers['sec-fetch-mode'] ?? null,
					accept: req.headers.accept ?? null,
				};
				return log;
			};
			// a webidentity endpoint that the proxy failed to label: fail loudly so
			// the suite's happy path only passes when the header is forwarded. The
			// signin, log and the RP page itself are not webidentity fetches.
			const isEndpoint =
				/fedcm-(config|accounts|client|token|disconnect)\b/.test(path);
			if (isEndpoint && path !== '/pages/fedcm-log' && dest !== 'webidentity') {
				record(path.replace('/pages/fedcm-', '').replace('.json', ''));
				res.statusCode = 400;
				res.setHeader('content-type', 'application/json');
				return res.end(JSON.stringify({ error: 'expected webidentity' }));
			}
			const sendJSON = (body) => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify(body));
			};
			// /pages/fedcm-log?k=<run>: what each step saw
			if (path === '/pages/fedcm-log') return sendJSON(fedcmLog.get(run) ?? {});
			// seed the IdP's session cookie (credentialed), so the accounts step
			// carries it and the config/metadata steps (uncredentialed) do not
			if (path === '/pages/fedcm-signin') {
				res.setHeader(
					'set-cookie',
					'fedcm_sid=yes; Path=/; SameSite=None; Secure',
				);
				return sendJSON({ signedIn: true });
			}
			if (path === '/pages/fedcm-config.json') {
				record('config');
				const q = run ? `?k=${encodeURIComponent(run)}` : '';
				return sendJSON({
					accounts_endpoint: `fedcm-accounts.json${q}`,
					client_metadata_endpoint: `fedcm-client.json${q}`,
					id_assertion_endpoint: `fedcm-token.json${q}`,
					disconnect_endpoint: `fedcm-disconnect.json${q}`,
					login_url: 'fedcm.html',
				});
			}
			if (path === '/pages/fedcm-accounts.json') {
				record('accounts');
				// one returning account (approved_clients holds the RP), so a flow
				// that allows it auto-selects without a chooser; `?multi` adds a
				// second, unapproved account to force the chooser
				const accounts = [
					{
						id: 'acct-1',
						name: 'Ada Proxy',
						email: 'ada@idp.test',
						given_name: 'Ada',
						approved_clients: ['stomp-rp'],
					},
				];
				if (query.has('multi'))
					accounts.push({
						id: 'acct-2',
						name: 'Bo Guest',
						email: 'bo@idp.test',
						given_name: 'Bo',
					});
				return sendJSON({ accounts });
			}
			if (path === '/pages/fedcm-client.json') {
				record('client');
				return sendJSON({
					privacy_policy_url: 'https://idp.test/privacy',
					terms_of_service_url: 'https://idp.test/terms',
				});
			}
			if (path === '/pages/fedcm-token.json') {
				const chunks = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					const body = new URLSearchParams(Buffer.concat(chunks).toString());
					const log = record('token');
					log.token = {
						...log.token,
						method: req.method,
						contentType: req.headers['content-type'] ?? null,
						clientId: body.get('client_id'),
						nonce: body.get('nonce'),
						accountId: body.get('account_id'),
						disclosureTextShown: body.get('disclosure_text_shown'),
						isAutoSelected: body.get('is_auto_selected'),
					};
					// a token the suite can read back to prove the POST's body round-
					// tripped through the proxy with the chosen account and flags
					if (query.has('error'))
						return sendJSON({
							error: { code: 'invalid_request', url: 'https://idp.test/e' },
						});
					sendJSON({
						token: `idtok.${body.get('account_id')}.${body.get('is_auto_selected')}.${body.get('nonce')}`,
					});
				});
				return;
			}
			if (path === '/pages/fedcm-disconnect.json') {
				const chunks = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					const body = new URLSearchParams(Buffer.concat(chunks).toString());
					record('disconnect');
					sendJSON({ account_id: body.get('account_hint') ?? 'acct-1' });
				});
				return;
			}
		}
		// /http-cache[/<any>]?k=<run>&n=<name>: a counting body under the
		// caching headers the query names, and a log of what each request
		// asked (http-cache suite). `cc`, `vary`, `pragma`: the headers as
		// given; `etag`: an ETag; `lm=<s>`: a Last-Modified that long ago;
		// `expires=<s>`: an Expires that far ahead (`0`: as written); `status`; `sc`: a
		// Set-Cookie; `csd`: a Clear-Site-Data; `age`: an Age; `chunked`: no
		// Content-Length;
		// `fail`: 500 after the first answer; `html`: a document, `img`: with
		// an image in it; `ranges`: a Range of bytes gets a 206 of them. A
		// matching validator gets a 304; a method other than GET is logged
		// before the headers. /http-cache/log?k=
		// is the log, /http-cache/clear?what= answers with that Clear-Site-Data
		if (path === '/http-cache/log') {
			const run = new URL(req.url, 'http://x').searchParams.get('k');
			res.setHeader('content-type', 'application/json');
			res.setHeader('cache-control', 'no-store');
			return res.end(JSON.stringify(httpCacheLog.get(run) ?? {}));
		}
		if (path === '/http-cache/clear') {
			res.setHeader('cache-control', 'no-store');
			res.setHeader(
				'clear-site-data',
				new URL(req.url, 'http://x').searchParams.get('what') ?? '',
			);
			return res.end('cleared');
		}
		if (path === '/http-cache/target') {
			res.setHeader('cache-control', 'no-store');
			return res.end('target');
		}
		if (path === '/http-cache' || path.startsWith('/http-cache/')) {
			const query = new URL(req.url, 'http://x').searchParams;
			const run = query.get('k');
			const name = query.get('n');
			const log = httpCacheLog.get(run) ?? {};
			httpCacheLog.set(run, log);
			const entry = (log[name] ??= { asked: [], bodies: 0, modified: null });
			if (query.has('lm'))
				entry.modified ??= new Date(
					Date.now() - Number(query.get('lm')) * 1000,
				).toUTCString();
			const asked = req.method === 'GET' ? [] : [req.method];
			for (const header of [
				'if-none-match',
				'if-modified-since',
				'cache-control',
				'pragma',
				'range',
				'if-range',
			])
				if (req.headers[header] !== undefined)
					asked.push(
						header.startsWith('if-')
							? header
							: `${header}: ${req.headers[header]}`,
					);
			res.setHeader(
				'content-type',
				query.has('html') ? 'text/html' : 'text/plain',
			);
			for (const header of ['cc', 'vary', 'pragma'])
				if (query.has(header))
					res.setHeader(
						header === 'cc' ? 'cache-control' : header,
						query.get(header),
					);
			if (query.has('etag')) res.setHeader('etag', '"e1"');
			if (entry.modified) res.setHeader('last-modified', entry.modified);
			if (query.has('expires'))
				res.setHeader(
					'expires',
					query.get('expires') === '0'
						? '0'
						: new Date(
								Date.now() + Number(query.get('expires')) * 1000,
							).toUTCString(),
				);
			// (`sc=seen`: one the page can read, that says which answer set it)
			if (query.has('sc'))
				res.setHeader(
					'set-cookie',
					query.get('sc') === 'seen'
						? `hcseen=${entry.asked.length + 1}; path=/`
						: `hc-sc=${Date.now()}; path=/never`,
				);
			if (query.has('csd')) res.setHeader('clear-site-data', query.get('csd'));
			if (query.has('age')) res.setHeader('age', query.get('age'));
			if (
				(query.has('etag') && req.headers['if-none-match'] === '"e1"') ||
				(entry.modified && req.headers['if-modified-since'] === entry.modified)
			) {
				entry.asked.push(['304', ...asked].join(' '));
				res.statusCode = 304;
				return res.end();
			}
			const status =
				query.has('fail') && entry.bodies > 0
					? 500
					: Number(query.get('status')) || 200;
			// (`ranges`: the first bytes a Range names, as a 206)
			const range =
				query.has('ranges') && status === 200
					? /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
					: null;
			entry.asked.push([String(range ? 206 : status), ...asked].join(' '));
			res.statusCode = status;
			if (status >= 300 && status < 400 && status !== 300)
				res.setHeader('location', '/http-cache/target');
			// (`img`: a document with an image that is fresh for an hour)
			const body = `#${++entry.bodies}${
				query.has('img')
					? `<img src="/http-cache/img?k=${encodeURIComponent(run)}&n=${encodeURIComponent(name)}-img&cc=max-age%3D3600">`
					: ''
			}`;
			if (query.has('ranges')) res.setHeader('accept-ranges', 'bytes');
			if (range) {
				const [from, to] = [Number(range[1]), Number(range[2])];
				const part = body.slice(from, to + 1);
				res.statusCode = 206;
				res.setHeader(
					'content-range',
					`bytes ${from}-${from + part.length - 1}/${body.length}`,
				);
				res.setHeader('content-length', part.length);
				return res.end(part);
			}
			if (!query.has('chunked')) res.setHeader('content-length', body.length);
			return res.end(body);
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
			// a Range request gets a 206 of the raw file bytes. The sidecar's
			// content-encoding stays, so a Range of an encoded file is a
			// fragment of the *compressed* stream, exactly as a CDN serves it:
			// the transport must pass such a partial body through, not try to
			// decode it (range-encoding suite; deploy/epoxy patch 0060)
			const bytes = readFileSync(`${pagesDir}${file}`);
			const asked = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
			if (asked) {
				res.setHeader('accept-ranges', 'bytes');
				const from = Number(asked[1]);
				const to =
					asked[2] === ''
						? bytes.length - 1
						: Math.min(Number(asked[2]), bytes.length - 1);
				if (from > to || from >= bytes.length) {
					res.statusCode = 416;
					res.setHeader('content-range', `bytes */${bytes.length}`);
					return res.end();
				}
				const part = bytes.subarray(from, to + 1);
				res.statusCode = 206;
				res.setHeader('content-range', `bytes ${from}-${to}/${bytes.length}`);
				res.setHeader('content-length', part.length);
				return res.end(part);
			}
			return res.end(bytes);
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
