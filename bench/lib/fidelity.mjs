// The fidelity and security battery: web-platform behaviours measured inside
// fixture pages (bench/fixtures/fidelity/), scored per check as equality with
// what native Chrome observes in the same situation, plus a leak check that
// counts requests a proxied page makes outside the proxy on a set of escape
// vectors. Nothing here knows any contender: every row loads the same pages
// the same way, and the expected value of a check is native's.
//
//   node bench/lib/fidelity.mjs [--only native,stomp-js] [--headful] [--out file.json]
//                               [--repeats n] [--native-secure]
//
// Each page writes { done, checks: { id: value }, vectors: { id: 'fired' | ... } }
// into data-bench-result on <html>; the harness reads it from an isolated
// world. Pages and vectors are listed below with their titles; the page code
// is the definition of each check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sleep } from './net.mjs';

/** pages of checks: group, path (query run=<token> is added), check id -> title */
export const PAGES = [
	{
		group: 'location',
		path: '/fidelity/location.html?q=1#frag',
		checks: {
			'location.href': 'location.href is the real URL',
			'location.origin': 'location.origin',
			'location.protocol': 'location.protocol',
			'location.host': 'location.host',
			'location.hostname': 'location.hostname',
			'location.port': 'location.port',
			'location.pathname': 'location.pathname',
			'location.search': 'location.search',
			'location.hash': 'location.hash',
			'location.to-string': 'String(location)',
			'location.document-url': 'document.URL and document.documentURI',
			'location.base-uri': 'document.baseURI',
			'location.window-origin': 'window.origin and self.origin',
			'location.document-domain': 'document.domain',
			'location.document-location': 'document.location is location',
			'location.ancestor-origins':
				'location.ancestorOrigins of the top document is empty',
			'location.top-is-self': 'window.top, window.parent are the window itself',
			'location.frame-element': 'frameElement is null in the top document',
			'location.opener': 'window.opener is null',
			'location.referrer': 'document.referrer of a typed navigation',
			'location.url-of-location': 'new URL(relative, location)',
			'location.computed-access':
				'location reached through computed property names',
			'location.eval': 'location read in eval and new Function',
			'location.hash-set': 'location after assigning location.hash',
		},
	},
	{
		group: 'url-resolution',
		path: '/fidelity/url.html',
		checks: {
			'url.anchor-relative':
				'relative, parent, absolute-path and protocol-relative anchor hrefs',
			'url.anchor-cross-origin': 'URL parts of a cross-origin anchor',
			'url.anchor-attribute': 'href attributes read back as written',
			'url.img-src': 'img src, currentSrc and the raw src/srcset attributes',
			'url.set-then-read': 'src/href properties after setting relative URLs',
			'url.form-action': 'form.action with and without an action attribute',
			'url.link-and-script': 'link.href, script.src and styleSheets[0].href',
			'url.current-script': 'document.currentScript.src in an external script',
			'url.module-meta': 'import.meta.url of an inline module script',
			'url.new-url': 'new URL against document.baseURI, Request.url',
			'url.computed-style':
				'computed background-image URLs (rule and style attribute)',
			'url.style-readback':
				'style.backgroundImage and the style attribute read back',
			'url.outer-html': 'outerHTML of elements with URL attributes',
			'url.inner-html-roundtrip': 'innerHTML round trip of URL attributes',
			'url.blob-url': 'URL.createObjectURL origin',
			'url.performance-entries': 'navigation and resource timing entry names',
			'url.css-rule-href': 'a stylesheet rule text and sheet.href',
		},
	},
	{
		group: 'cookies',
		path: '/fidelity/cookies.html',
		checks: {
			'cookies.from-response':
				'document.cookie after Set-Cookie on the page (HttpOnly hidden)',
			'cookies.script-set': 'document.cookie after script sets cookies',
			'cookies.path-scope': 'Path attribute scoping in document.cookie',
			'cookies.delete': 'Max-Age=0 and past Expires delete',
			'cookies.attributes':
				'SameSite=None without Secure, Secure, Lax, a foreign Domain',
			'cookies.domain-attribute':
				'Domain=bench.test accepted, Domain=c.bench.test rejected',
			'cookies.sent-same-origin':
				'Cookie header the server receives on a same-origin fetch',
			'cookies.fetch-set-cookie':
				'Set-Cookie on a fetch response (HttpOnly sent, not visible)',
			'cookies.credentials-omit': 'credentials omit sends no Cookie',
			'cookies.cross-origin-include':
				'Cookie on a CORS fetch to b. with credentials include',
			'cookies.cross-origin-default':
				'no Cookie on a CORS fetch to b. by default',
			'cookies.cross-origin-set':
				'Set-Cookie from b. on a credentialed CORS fetch',
			'cookies.other-origin-frame': 'document.cookie in a b. frame',
			'cookies.other-origin-frame-set':
				'a cookie set in a b. frame stays with b.',
			'cookies.subresource': 'Cookie header the server receives for an img',
			'secure.cookie-secure-attribute': [
				'whether a Secure cookie is accepted',
				'secure-context',
			],
			'secure.cookie-store': ['cookieStore set and getAll', 'secure-context'],
		},
	},
	{
		group: 'storage',
		path: '/fidelity/storage.html',
		checks: {
			'storage.local': 'localStorage set, get, length, keys',
			'storage.session': 'sessionStorage separate from localStorage',
			'storage.remove-and-clear': 'removeItem and clear',
			'storage.same-origin-frame': 'a same-origin frame shares localStorage',
			'storage.event': 'storage event in a same-origin frame (key, value, url)',
			'storage.other-origin-frame': 'a b. frame has its own localStorage',
			'storage.other-origin-write': 'a b. frame write stays with b.',
			'storage.indexeddb': 'IndexedDB round trip and databases()',
			'storage.indexeddb-other-origin': 'a b. frame sees no a. databases',
			'secure.cache-storage': [
				'CacheStorage open, put, keys, match',
				'secure-context',
			],
			'storage.third-party-frame':
				'a cross-site frame: origin, storage, cookies',
			'storage.cross-site-ancestor':
				'an a. frame under a cross-site frame is partitioned',
		},
	},
	{
		group: 'postmessage',
		path: '/fidelity/postmessage.html',
		checks: {
			'postmessage.from-same-origin-child':
				'origin and source of a same-origin child message',
			'postmessage.from-cross-origin-child':
				'origin and source of a b. child message',
			'postmessage.event-shape':
				'MessageEvent type, lastEventId, ports, isTrusted, flags',
			'postmessage.child-sees-parent':
				'origin and source a child sees for the parent message',
			'postmessage.target-origin':
				'targetOrigin matching (origin, URL, wrong origin, wrong port)',
			'postmessage.target-origin-slash':
				"targetOrigin '/' delivers only same-origin",
			'postmessage.invalid-target': 'an invalid targetOrigin throws',
			'postmessage.self': 'a message to the window itself',
			'postmessage.urls-in-data': 'URLs inside message data arrive unchanged',
			'postmessage.structured-clone':
				'structured clone of Date, Map, RegExp, typed arrays, Set',
			'postmessage.uncloneable': 'posting a function throws',
			'postmessage.message-channel': 'MessageChannel event origin and source',
			'postmessage.transfer-port': 'a transferred MessagePort works',
			'postmessage.nested-cross-origin':
				'messages to and from a frame nested in a b. frame',
			'postmessage.broadcast-channel':
				'BroadcastChannel reaches same-origin frames only',
		},
	},
	{
		group: 'workers',
		path: '/fidelity/workers.html',
		checks: {
			'workers.dedicated-location':
				'worker location.href, origin, pathname, search',
			'workers.dedicated-resolve':
				'importScripts and URL resolution in a worker',
			'workers.dedicated-fetch':
				'worker fetch: response.url, Host, Referer, Origin the server sees',
			'workers.message-event': 'message events between window and worker',
			'workers.module':
				'module worker: import.meta.url, location, static import',
			'workers.blob': 'blob: worker location, origin and URL resolution',
			'workers.blob-module': 'blob: module worker import.meta.url, origin',
			'workers.data-url': 'data: worker has an opaque origin',
			'workers.cross-origin-script': 'a cross-origin worker script throws',
			'workers.shared':
				'SharedWorker shared between two connections, location, name',
			'secure.service-worker-register': [
				'navigator.serviceWorker.register scope and scriptURL',
				'secure-context',
			],
			'secure.service-worker-page': [
				'a page in the service worker scope is served by it',
				'secure-context',
			],
			'secure.service-worker-registrations': [
				'getRegistrations scopes',
				'secure-context',
			],
		},
	},
	{
		group: 'fetch-xhr',
		path: '/fidelity/fetch.html',
		checks: {
			'fetch.same-origin':
				'same-origin fetch: response and request headers seen',
			'fetch.same-origin-post': 'same-origin POST: Origin, body, content type',
			'fetch.cross-origin-cors':
				'CORS fetch to b.: type, exposed header, request headers',
			'fetch.cross-origin-no-acao': 'a cross-origin fetch without ACAO rejects',
			'fetch.no-cors': 'no-cors fetch is opaque',
			'fetch.preflight': 'a custom header triggers one CORS preflight',
			'fetch.redirect': 'same-origin redirect: url, redirected',
			'fetch.redirect-cross-origin': '307 redirect to b.: url, request headers',
			'fetch.redirect-manual': "redirect 'manual' gives an opaqueredirect",
			'fetch.redirect-error': "redirect 'error' rejects",
			'fetch.referrer-policy': 'no-referrer, origin and a custom referrer',
			'fetch.request-object': 'Request url, referrer, mode, credentials',
			'fetch.data-and-blob': 'fetch of data: and blob: URLs',
			'fetch.xhr-same-origin': 'XHR status, responseURL, request headers',
			'fetch.xhr-redirect': 'XHR responseURL after a redirect',
			'fetch.xhr-cross-origin': 'XHR to b. with and without CORS',
			'fetch.xhr-response-headers': 'XHR getAllResponseHeaders',
			'fetch.subresource-headers': 'request headers of a cross-origin img',
			'secure.sec-fetch-headers': [
				'Sec-Fetch-Site/Mode/Dest the server sees (same-origin, CORS, img)',
				'secure-context',
			],
			'fetch.beacon': 'sendBeacon method and content type',
		},
	},
	{
		group: 'iframes',
		path: '/fidelity/iframes.html',
		checks: {
			'iframes.same-origin-child':
				'what a same-origin child sees of itself and its parent',
			'iframes.same-origin-access': 'parent access into a same-origin child',
			'iframes.cross-origin-child':
				'what a b. child sees of itself and its parent',
			'iframes.cross-origin-access':
				'parent access into a b. child throws where it should',
			'iframes.cross-origin-navigate': 'navigating a b. child by its location',
			'iframes.srcdoc': 'srcdoc frame URL, origin, base URL',
			'iframes.about-blank': 'about:blank frame written by script',
			'iframes.javascript-url': 'javascript: URL frame',
			'iframes.sandboxed': 'sandboxed frame: opaque origin, no storage',
			'iframes.relative-src': 'relative frame src, frame location',
			'iframes.frame-count': 'window.length matches the iframe count',
		},
	},
	{
		group: 'history',
		path: '/fidelity/history.html',
		checks: {
			'history.initial': 'history.state and scrollRestoration on load',
			'history.navigation-api':
				'Navigation API current entry and entries on load',
			'history.link-navigation':
				'document.referrer and history.length growth after a link navigation in a frame',
			'history.push-state':
				'location and history.length growth after pushState',
			'history.push-state-base': 'base URL after pushState',
			'history.replace-state': 'location and history after replaceState',
			'history.push-state-cross-origin': 'pushState to another origin throws',
			'history.push-state-uncloneable':
				'pushState with an uncloneable state throws',
			'history.popstate': 'popstate after history.back()',
			'history.hashchange': 'hashchange oldURL/newURL',
			'history.navigation-api-after': 'Navigation API entries after it all',
		},
	},
	{
		group: 'sockets',
		path: '/fidelity/sockets.html',
		checks: {
			'sockets.websocket-open':
				'WebSocket url, protocol, extensions, readyState',
			'sockets.websocket-handshake':
				'path, Host, Origin, Cookie the server sees on the upgrade',
			'sockets.websocket-message-event': 'WebSocket message event origin',
			'sockets.websocket-echo': 'text and binary echo',
			'sockets.websocket-close': 'server close code, reason, wasClean',
			'sockets.websocket-relative': 'WebSocket with a relative URL',
			'sockets.websocket-subprotocol': 'the subprotocol the server chose',
			'sockets.websocket-cross-origin': 'WebSocket to b.: url and Origin',
			'sockets.websocket-bad-url': 'a non-ws URL throws',
			'sockets.eventsource':
				'EventSource url, named and default events, lastEventId, origin',
			'sockets.eventsource-cross-origin':
				'EventSource to b. without CORS errors',
		},
	},
	{
		group: 'misc',
		path: '/fidelity/misc.html',
		checks: {
			'misc.native-to-string':
				'Function.prototype.toString of native functions',
			'misc.location-descriptors':
				'property descriptors of window.location and location.assign',
			'misc.window-own-keys': 'own enumerable properties of window',
			'misc.document-own-keys': 'own properties of document and location',
			'misc.inline-script-text':
				'an inline script reads its own source unchanged',
			'misc.script-elements': 'script and element counts of the document',
			'misc.markup': 'outerHTML of a plain element',
			'misc.error-stack-url': 'script URL in Error().stack',
			'misc.document-props':
				'title, characterSet, compatMode, contentType, visibility',
			'secure.is-secure-context': [
				'isSecureContext and the APIs it gates',
				'secure-context',
			],
			'misc.cross-origin-isolated': 'crossOriginIsolated and SharedArrayBuffer',
			'misc.viewport': 'innerWidth/innerHeight, devicePixelRatio, screen',
			'misc.window-name': 'window.name of a fresh top document',
			'misc.eval-forms': 'indirect eval and new Function see the page globals',
			'misc.dom-url-attributes': 'attributes of parsed markup with URLs',
			'misc.reflect-src': 'Reflect.set and the prototype setter on img.src',
			'misc.dom-parser': 'DOMParser document URL and resolution',
			'misc.navigator': 'navigator.webdriver, cookieEnabled, onLine',
		},
	},
];

/** leak pages and their vectors (id -> title); each fires at /leak/<id>?run=<token> */
export const LEAK_PAGES = [
	{
		page: 'leak-elements',
		path: '/fidelity/leak-elements.html',
		vectors: {
			'link-stylesheet': '<link rel=stylesheet>',
			'link-preload': '<link rel=preload as=image>',
			'link-prefetch': '<link rel=prefetch>',
			'link-icon': '<link rel=icon>',
			'css-import': '<style> @import',
			'css-font-face': '<style> @font-face in use',
			'script-attr': '<script src>',
			'img-attr': '<img src>',
			'img-srcset': '<img srcset>',
			'picture-source': '<picture><source srcset>',
			'iframe-attr': '<iframe src>',
			'video-poster': '<video poster>',
			'audio-src': '<audio src preload=auto>',
			'video-source': '<video><source src>',
			track: '<track default src>',
			embed: '<embed src type=text/html>',
			object: '<object data type=text/html>',
			'input-image': '<input type=image src>',
			'svg-image': '<svg><image href>',
			'svg-use': '<svg><use href> (same origin)',
			'css-style-attr': 'style attribute url()',
			'document-write': 'document.write of an img while parsing',
			'cssom-property': 'style.backgroundImage =',
			'cssom-csstext': 'style.cssText =',
			'cssom-setproperty': 'style.setProperty',
			'cssom-insertrule': 'CSSStyleSheet.insertRule',
			'adopted-stylesheet': 'constructed sheet in adoptedStyleSheets',
			'style-element-text': '<style> textContent set by script',
			'dom-innerhtml': 'innerHTML',
			'dom-outerhtml': 'outerHTML',
			'dom-insertadjacent': 'insertAdjacentHTML',
			'contextual-fragment': 'Range.createContextualFragment',
			'domparser-import': 'DOMParser document + importNode',
			'template-clone': '<template> content cloned in',
			'set-attribute': 'setAttribute(src)',
			'set-attribute-ns': 'setAttributeNS(null, src)',
			'attribute-node': 'createAttribute + setAttributeNode',
			'reflect-set': 'Reflect.set(img, src)',
			'prototype-setter':
				'HTMLImageElement.prototype src setter called directly',
			'srcset-property': 'img.srcset =',
			'script-dynamic': 'script element with src appended by script',
		},
	},
	{
		page: 'leak-js',
		path: '/fidelity/leak-js.html',
		vectors: {
			fetch: 'fetch',
			'fetch-request': 'fetch(new Request) no-cors',
			xhr: 'XMLHttpRequest',
			beacon: 'navigator.sendBeacon',
			websocket: 'WebSocket',
			eventsource: 'EventSource',
			'new-image': 'new Image().src',
			'new-audio': 'new Audio(url)',
			'dynamic-import': 'import()',
			'worker-script': 'new Worker (same-origin script URL)',
			'worker-module': 'new Worker type module',
			'shared-worker': 'new SharedWorker',
			'worker-importscripts': 'importScripts in a worker',
			'worker-fetch': 'fetch in a worker',
			'worker-websocket': 'WebSocket in a worker',
			'blob-worker-fetch': 'fetch in a blob: worker',
			'sw-register': 'navigator.serviceWorker.register',
			'paint-worklet': 'CSS.paintWorklet.addModule',
			'audio-worklet': 'audioWorklet.addModule',
		},
	},
	{
		page: 'leak-nav',
		path: '/fidelity/leak-nav.html',
		vectors: {
			'link-header': 'Link: rel=preload response header',
			'form-get': 'form GET submitted into a frame',
			'form-post': 'form POST submitted into a frame',
			'a-ping': '<a ping> click',
			'link-click': '<a target=frame> click',
			'meta-refresh': '<meta http-equiv=refresh> in a frame',
			'refresh-header': 'Refresh response header in a frame',
			'frame-location-assign': 'location.href = in a frame',
			'frame-location-replace': 'location.replace in a frame',
			'frame-open-self': "window.open(url, '_self') in a frame",
			'frame-location-parent': "parent sets a frame's location",
			'window-open': 'window.open popup (closed after 2 s)',
			'iframe-javascript-url': 'javascript: URL frame with an img',
			'iframe-data-url': 'data: URL frame with an img',
			'iframe-srcdoc': 'srcdoc frame with an img',
			'iframe-blob-url': 'blob: URL HTML frame with an img',
			'about-blank-write': 'about:blank frame written by script',
			'base-href': '<base href> + relative img in a frame',
			'push-state-relative': 'pushState then a relative fetch in a frame',
			'csp-report': 'CSP report-uri of a frame',
		},
	},
];

/** order-insensitive for object keys, strict for everything else */
export function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a))
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Vectors behind a secure context. The fixture origins are plain http, so
 * natively these APIs are missing and the vectors cannot fire, while every
 * proxied page runs under a host on 127.0.0.1, which is a secure context, so
 * a proxy may well expose them. They are scored without the native gate when
 * native reports the API unavailable (each of them fires natively under
 * nativeSecureArgs, the CLI's --native-secure).
 */
export const SECURE_ONLY = ['sw-register', 'paint-worklet', 'audio-worklet'];

/**
 * Chrome flags that make the native browser treat the fixture origins as
 * secure (as it would https sites). Not the default: the expected value of a
 * check is what native Chrome does with the same http URL. Useful to see
 * which checks depend on the scheme.
 */
export function nativeSecureArgs(port) {
	const origins = ['a', 'b', 'c']
		.map((name) => `http://${name}.bench.test:${port}`)
		.concat(`http://127.0.0.1:${port}`);
	return [`--unsafely-treat-insecure-origin-as-secure=${origins.join(',')}`];
}

const token = () => `r${Math.random().toString(36).slice(2, 10)}`;

function withRun(path, run) {
	const [rest, hash] = path.split('#');
	return `${rest}${rest.includes('?') ? '&' : '?'}run=${run}${hash !== undefined ? `#${hash}` : ''}`;
}

function parseResult(text) {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** loads one page in a fresh tab and waits for its result (done or not) */
async function loadPage({ env, row, open, load, path, log, waitMs = 25000 }) {
	const run = token();
	const url = env.fixture.url('a', withRun(path, run));
	const t0 = Date.now();
	let tab = null;
	let result = null;
	let error = null;
	let loadResult = null;
	let bootRetry = null;
	try {
		tab = await open(row);
		// a host that failed to boot says nothing about the page: one more try
		if (tab.bootError) {
			log(`${row} boot failed (${tab.bootError}), retrying once`);
			bootRetry = tab.bootError;
			await tab.context?.close().catch(() => {});
			tab = await open(row);
		}
		if (tab.bootError) throw new Error(`boot: ${tab.bootError}`);
		loadResult = await load(tab, url, { timeoutMs: 30000, settleMs: 200 });
		result = parseResult(loadResult?.snap?.benchResult);
		const end = Date.now() + waitMs;
		while (!result?.done && Date.now() < end) {
			await sleep(250);
			const snap = await tab.probe
				.snapshot(tab.frameId, { text: false })
				.catch(() => null);
			result = parseResult(snap?.benchResult) || result;
		}
		if (!result?.done)
			error = loadResult?.timedOut
				? 'page never loaded'
				: loadResult?.error || 'page never finished';
	} catch (e) {
		error = e.message.split('\n')[0];
	}
	const t1 = Date.now();
	await tab?.context?.close().catch(() => {});
	log(
		`${row} ${path.split('?')[0]} ${error ? `FAILED ${error}` : 'done'} ${t1 - t0} ms`,
	);
	return {
		run,
		url,
		t0,
		t1,
		result,
		error,
		bootRetry,
		loadError: loadResult?.navError,
	};
}

function leakPaths(hitsOrLog, run, id) {
	return hitsOrLog.filter((entry) => {
		if (!entry.url) return false;
		const url = new URL(entry.url, 'http://x');
		return (
			url.pathname === `/leak/${id}` &&
			// a form GET carries the token as a field like the rest
			url.searchParams.get('run') === run
		);
	}).length;
}

/**
 * Runs the battery. See the header of this file and bench/README.md.
 * rows: 'native' first. open(row) -> tab; load(tab, url, opts) -> loadURL result.
 */
export async function runFidelity({
	env,
	rows,
	open,
	load,
	repeats = 1,
	log = () => {},
}) {
	if (rows[0] !== 'native') throw new Error("rows must start with 'native'");
	const raw = Object.fromEntries(rows.map((row) => [row, {}])); // row -> page -> [runs]
	const leakRuns = Object.fromEntries(rows.map((row) => [row, {}]));
	for (let repeat = 0; repeat < repeats; repeat++) {
		for (const page of PAGES)
			for (const row of rows) {
				const run = await loadPage({
					env,
					row,
					open,
					load,
					path: page.path,
					log,
				});
				(raw[row][page.group] ||= []).push(run);
			}
		for (const page of LEAK_PAGES)
			for (const row of rows) {
				const run = await loadPage({
					env,
					row,
					open,
					load,
					path: page.path,
					log,
				});
				// requests still in flight when the tab closed are counted too
				await sleep(300);
				run.leakHits = env.leak.since(run.t0);
				run.served = env.fixture.log.filter((entry) => entry.t >= run.t0);
				(leakRuns[row][page.page] ||= []).push(run);
			}
	}

	// checks
	const checks = [];
	const results = Object.fromEntries(rows.map((row) => [row, {}]));
	const notes = [];
	for (const page of PAGES) {
		const nativeRuns = raw.native[page.group];
		for (const [id, entry] of Object.entries(page.checks)) {
			// [title, group] puts a check in another group than its page's
			const [title, group] = Array.isArray(entry) ? entry : [entry, page.group];
			const values = nativeRuns.map((run) => run.result?.checks?.[id]);
			if (values.some((value) => value === undefined)) {
				notes.push(`${id}: dropped, no native value`);
				continue;
			}
			if (!values.every((value) => deepEqual(value, values[0]))) {
				notes.push(`${id}: dropped, native values differ between repeats`);
				continue;
			}
			checks.push({ id, group, title });
			const native = values[0];
			for (const row of rows) {
				const runs = raw[row][page.group];
				// every repeat has to match; the first failing one is shown
				let entry = { pass: true, native, proxied: native, note: '' };
				for (const run of runs) {
					const value = run.result?.checks?.[id];
					if (!run.result?.done) {
						entry = {
							pass: false,
							native,
							proxied: value ?? null,
							note: run.error || 'page never finished',
						};
						break;
					}
					if (value === undefined) {
						entry = {
							pass: false,
							native,
							proxied: null,
							note: run.result?.notes?.[id] || 'missing',
						};
						break;
					}
					if (!deepEqual(value, native)) {
						entry = { pass: false, native, proxied: value, note: '' };
						break;
					}
				}
				results[row][id] = entry;
			}
		}
		for (const run of nativeRuns)
			for (const id of Object.keys(run.result?.checks || {}))
				if (!page.checks[id] && !notes.includes(`${id}: not in the catalogue`))
					notes.push(`${id}: not in the catalogue`);
	}
	const summary = {};
	for (const row of rows) {
		const by_group = {};
		let passed = 0;
		for (const check of checks) {
			const group = (by_group[check.group] ||= [0, 0]);
			group[1]++;
			if (results[row][check.id].pass) {
				group[0]++;
				passed++;
			}
		}
		summary[row] = { passed, total: checks.length, by_group };
	}

	// leaks
	const vectors = [];
	const leakResults = Object.fromEntries(rows.map((row) => [row, {}]));
	const detail = Object.fromEntries(rows.map((row) => [row, {}]));
	const leakSummary = {};
	for (const page of LEAK_PAGES)
		for (const [id, title] of Object.entries(page.vectors)) {
			const nativeFired = leakRuns.native[page.page].every(
				(run) => leakPaths(run.served, run.run, id) > 0,
			);
			const insecure =
				SECURE_ONLY.includes(id) &&
				leakRuns.native[page.page].every((run) =>
					/Unavailable/.test(JSON.stringify(run.result?.vectors?.[id])),
				);
			if (!nativeFired && !insecure) {
				notes.push(`leak ${id}: not scored, it did not fire natively`);
				continue;
			}
			vectors.push({
				id,
				title,
				page: page.page,
				...(insecure && {
					note: 'unavailable natively (http), scored ungated',
				}),
			});
			for (const row of rows) {
				let leaked = 0;
				let proxied = 0;
				let ran = true;
				for (const run of leakRuns[row][page.page]) {
					leaked += leakPaths(run.leakHits, run.run, id);
					proxied += leakPaths(run.served, run.run, id);
					const state = run.result?.vectors?.[id];
					if (typeof state !== 'string' || !/^(fired|markup)/.test(state))
						ran = false;
				}
				leakResults[row][id] = row === 'native' ? 0 : leaked;
				detail[row][id] =
					row !== 'native' && leaked
						? 'leaked'
						: proxied
							? 'proxied'
							: ran
								? 'blocked'
								: 'not-fired';
			}
		}
	for (const row of rows) {
		const counts = Object.values(leakResults[row]);
		leakSummary[row] = {
			vectors_leaked: counts.filter((n) => n > 0).length,
			vectors: vectors.length,
			requests: counts.reduce((a, b) => a + b, 0),
		};
	}
	// whole-run leak catcher hits outside /leak/ (a proxied page's own
	// fixture requests that bypassed the proxy), per row
	const strays = {};
	for (const row of rows.slice(1)) {
		const runs = [
			...Object.values(raw[row]).flat(),
			...Object.values(leakRuns[row]).flat(),
		];
		strays[row] = runs.reduce(
			(n, run) =>
				n +
				env.leak.hits.filter(
					(hit) =>
						hit.t >= run.t0 &&
						hit.t <= run.t1 &&
						!(hit.url || '').startsWith('/leak/'),
				).length,
			0,
		);
	}
	return {
		checks,
		results,
		summary,
		notes,
		pages: Object.fromEntries(
			rows.map((row) => [
				row,
				Object.fromEntries(
					[...Object.entries(raw[row]), ...Object.entries(leakRuns[row])].map(
						([page, runs]) => [
							page,
							runs.map((run) => ({
								ok: !!run.result?.done,
								error: run.error,
								bootRetry: run.bootRetry,
								ms: run.t1 - run.t0,
								notes: run.result?.notes,
							})),
						],
					),
				),
			]),
		),
		leaks: {
			vectors,
			results: leakResults,
			detail,
			summary: leakSummary,
			stray_hits: strays,
			vector_states: Object.fromEntries(
				rows.map((row) => [
					row,
					Object.fromEntries(
						Object.entries(leakRuns[row]).map(([page, runs]) => [
							page,
							runs[0]?.result?.vectors || null,
						]),
					),
				]),
			),
		},
	};
}

async function cli() {
	const { launch } = await import('./browser.mjs');
	const { DEFAULTS, loadAdapters, startEnv } = await import('./env.mjs');
	const { loadURL, openNativeTab, openProxiedTab, startRow } =
		await import('./session.mjs');
	const { values } = parseArgs({
		options: {
			only: { type: 'string' },
			headful: { type: 'boolean' },
			out: { type: 'string' },
			repeats: { type: 'string', default: '1' },
			'native-secure': { type: 'boolean' },
			chrome: { type: 'string', default: DEFAULTS.chrome },
			holywisp: { type: 'string', default: DEFAULTS.holywisp },
			contenders: { type: 'string', default: DEFAULTS.contenders },
			logs: { type: 'string', default: '/tmp/bench-fidelity-logs' },
		},
	});
	mkdirSync(values.logs, { recursive: true });
	const adapters = await loadAdapters();
	const allRows = adapters.flatMap((adapter) =>
		adapter.rows.map((row) => ({ adapter, row })),
	);
	const wanted = values.only
		? values.only.split(',').map((s) => s.trim())
		: ['native', ...allRows.map((r) => r.row.row)];
	const rows = ['native', ...wanted.filter((row) => row !== 'native')];
	const env = await startEnv({
		holywisp: values.holywisp,
		contenders: values.contenders,
		logDir: values.logs,
	});
	const running = {};
	const browsers = {};
	try {
		for (const row of rows.slice(1)) {
			const entry = allRows.find((r) => r.row.row === row);
			if (!entry) throw new Error(`no adapter has row ${row}`);
			running[row] = await startRow(env, entry.adapter, entry.row);
		}
		const common = {
			chrome: values.chrome,
			headful: values.headful,
			leakPort: env.leak.port,
			chromeVersion: '156',
		};
		browsers.native = await launch({
			...common,
			kind: 'native',
			extraArgs: values['native-secure']
				? nativeSecureArgs(env.fixture.port)
				: [],
		});
		if (rows.length > 1)
			browsers.proxy = await launch({ ...common, kind: 'proxy' });
		const t0 = Date.now();
		const report = await runFidelity({
			env,
			rows,
			repeats: Number(values.repeats),
			open: (row) =>
				row === 'native'
					? openNativeTab(browsers.native)
					: openProxiedTab(browsers.proxy, running[row]),
			load: loadURL,
			log: (line) => console.log(line),
		});
		console.log(`\nbattery took ${Math.round((Date.now() - t0) / 1000)} s`);
		for (const note of report.notes) console.log(`note: ${note}`);
		for (const row of rows) {
			const s = report.summary[row];
			const l = report.leaks.summary[row];
			const groups = Object.entries(s.by_group)
				.map(([group, [p, t]]) => `${group} ${p}/${t}`)
				.join(', ');
			console.log(
				`\n${row}: ${s.passed}/${s.total} checks (${groups}); leaks ${l.vectors_leaked}/${l.vectors} vectors, ${l.requests} requests${row === 'native' ? '' : `, stray hits ${report.leaks.stray_hits[row]}`}`,
			);
			if (row === 'native') continue;
			for (const check of report.checks) {
				const r = report.results[row][check.id];
				if (r.pass) continue;
				console.log(
					`  FAIL ${check.id}: native ${JSON.stringify(r.native).slice(0, 200)} | ${row} ${JSON.stringify(r.proxied).slice(0, 200)}${r.note ? ` (${r.note})` : ''}`,
				);
			}
			const leaked = Object.entries(report.leaks.detail[row])
				.filter(([, state]) => state !== 'proxied')
				.map(([id, state]) => `${id}=${state}`);
			if (leaked.length)
				console.log(`  leak vectors not proxied: ${leaked.join(', ')}`);
		}
		if (values.out) {
			mkdirSync(dirname(values.out), { recursive: true });
			writeFileSync(values.out, JSON.stringify(report, null, 1));
			console.log(`\nwrote ${values.out}`);
		}
	} finally {
		for (const browser of Object.values(browsers))
			await browser.close().catch(() => {});
		for (const handle of Object.values(running))
			await handle.stop().catch(() => {});
		await env.stop();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await cli();
