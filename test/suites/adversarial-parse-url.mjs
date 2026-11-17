// The URL parser differential fuzz (test/parserFuzz.mjs): URLs a page hands
// the platform, spelled every way Chrome's URL parser reads (backslashes,
// tabs and newlines inside, leading and trailing C0 controls and spaces,
// scheme-relative and scheme-only relative forms, percent-encoded dots,
// IPv4 shorthands, IDNA mappings, credentials, special and non-special
// schemes, blob:, data:, javascript: with controls inside its scheme), put
// through every call that takes one: fetch, XMLHttpRequest, sendBeacon,
// EventSource, WebSocket, an image, a script, a stylesheet, media, a
// dynamic import, a frame's src, its location (assign, replace, href),
// window.open into it, a link's click, a form's action, the Navigation API,
// and the readbacks (new URL, a link's href and parts). Each case is run
// natively and proxied; what Chrome fetched, threw and read back natively
// is what the proxied page must, nothing may go past the proxy, and a
// javascript: URL's code must run rewritten.
import {
	doneScript,
	headScript,
	js,
	prng,
	runDifferential,
} from '../parserFuzz.mjs';

const SEED = 0x0e1;
const SCALE = Number(process.env.FZ_SCALE || 1);
const PER_BATCH = 60;

/** code that reports it ran: what it saw as location and top */
const payload = (s, id, k = 0) =>
	`(function(){var l='x',t='x';try{l=location.href}catch(e){}try{t=top.location.href}catch(e){}(new Image).src=${js(`${s.origin}/fz/${id}/ran-${k}.png?l=`)}+encodeURIComponent(l)+'&t='+encodeURIComponent(t)})()`;

// how the URL of a case's file is spelled; the batch page's base is
// <origin>/fz/, so `ID/...` is relative to it
const SPELLINGS = {
	relative: (s, id, f) => `${id}/${f}`,
	'dot-relative': (s, id, f) => `./${id}/${f}`,
	'path-absolute': (s, id, f) => `/fz/${id}/${f}`,
	absolute: (s, id, f) => `${s.origin}/fz/${id}/${f}`,
	'other-origin': (s, id, f) => `${s.other}/fz/${id}/${f}`,
	'scheme-relative': (s, id, f) => `//127.0.0.1:${s.port}/fz/${id}/${f}`,
	backslashes: (s, id, f) => `\\fz\\${id}\\${f}`,
	'backslash-scheme-relative': (s, id, f) =>
		`\\\\127.0.0.1:${s.port}\\fz\\${id}\\${f}`,
	'mixed-slashes': (s, id, f) => `/\\127.0.0.1:${s.port}/fz/${id}/${f}`,
	'http-colon-path': (s, id, f) => `http:/fz/${id}/${f}`,
	'http-colon-relative': (s, id, f) => `http:${id}/${f}`,
	'http-triple-slash': (s, id, f) =>
		`http:///127.0.0.1:${s.port}/fz/${id}/${f}`,
	'upper-scheme': (s, id, f) => `HTTP://127.0.0.1:${s.port}/fz/${id}/${f}`,
	'dot-dot': (s, id, f) => `${id}/a/../${f}`,
	'pct-dot-dot': (s, id, f) => `${id}/a/%2e%2e/${f}`,
	'pct-dot-dot-mixed': (s, id, f) => `${id}/a/%2E./${f}`,
	'pct-dot': (s, id, f) => `${id}/%2e/${f}`,
	'tab-inside': (s, id, f) => `${id}/\t${f}`,
	'newline-inside': (s, id, f) => `${id}\n/${f}`,
	'cr-in-scheme': (s, id, f) => `ht\rtp://127.0.0.1:${s.port}/fz/${id}/${f}`,
	'tab-in-host': (s, id, f) => `http://127.0.\t0.1:${s.port}/fz/${id}/${f}`,
	'lead-trail-space': (s, id, f) => `  /fz/${id}/${f}  `,
	'lead-c0': (s, id, f) => `\u0001\u001f/fz/${id}/${f}`,
	'trail-c0': (s, id, f) => `/fz/${id}/${f}\u0000`,
	'lead-nbsp': (s, id, f) => `\u00a0/fz/${id}/${f}`,
	'ipv4-short': (s, id, f) => `http://127.1:${s.port}/fz/${id}/${f}`,
	'ipv4-hex': (s, id, f) => `http://0x7f.0.0.1:${s.port}/fz/${id}/${f}`,
	'ipv4-decimal': (s, id, f) => `http://2130706433:${s.port}/fz/${id}/${f}`,
	'ipv4-trailing-dot': (s, id, f) =>
		`http://127.0.0.1.:${s.port}/fz/${id}/${f}`,
	'port-leading-zero': (s, id, f) =>
		`http://127.0.0.1:0${s.port}/fz/${id}/${f}`,
	'upper-host': (s, id, f) => `http://LOCALHOST:${s.port}/fz/${id}/${f}`,
	'idna-circled': (s, id, f) => `http://ⓛocalhost:${s.port}/fz/${id}/${f}`,
	'idna-fullwidth': (s, id, f) => `http://ｌocalhost:${s.port}/fz/${id}/${f}`,
	'pct-host': (s, id, f) => `http://%6c%6fcalhost:${s.port}/fz/${id}/${f}`,
	credentials: (s, id, f) => `http://u:p@127.0.0.1:${s.port}/fz/${id}/${f}`,
	'empty-credentials': (s, id, f) =>
		`http://@127.0.0.1:${s.port}/fz/${id}/${f}`,
	fragment: (s, id, f) => `${id}/${f}#a b`,
	'query-chars': (s, id, f) => `${id}/${f}?a=b c&d='e'"<>\``,
	'path-unicode': (s, id, f) => `${id}/\u00e9${f}`,
	'path-pct-slash': (s, id, f) => `${id}%2f${f}`,
	'non-special': (s, id, f) => `foo://127.0.0.1:${s.port}/fz/${id}/${f}`,
	'ws-scheme': (s, id, f) => `ws://127.0.0.1:${s.port}/fz/${id}/${f}`,
	'blob-of-origin': (s, id, f) => `blob:${s.origin}/fz/${id}/${f}`,
	filesystem: (s, id, f) => `filesystem:${s.origin}/temporary/fz/${id}/${f}`,
	'view-source': (s, id, f) => `view-source:${s.origin}/fz/${id}/${f}`,
	// no URL at all: natively the call fails (or loads nothing) and the page
	// goes on
	'invalid-port': (s, id, f) => `http://127.0.0.1:PORTX/fz/${id}/${f}`,
	'invalid-ipv6': (s, id, f) => `http://[::1/fz/${id}/${f}`,
	'invalid-space-host': (s, id, f) => `http://a b/fz/${id}/${f}`,
	'invalid-empty-host': () => 'https://',
	'invalid-percent-host': (s, id, f) => `http://%zz/fz/${id}/${f}`,
};

// javascript: URLs, for the calls that navigate
const JS_SCHEMES = [
	'javascript:',
	'JAVASCRIPT:',
	' javascript:',
	'\u0001javascript:',
	'java\tscript:',
	'java\nscript:',
	'javascript\t:',
	'j\ra\nv\ta\tscript:',
	'jav%61script:',
	'javascript\u0000:',
	'\u00a0javascript:',
	'javascript:\u2028',
];

// each sink is code that runs `u` (the URL as a JS literal) for case `id`;
// `out` collects what the page reads back
const SINKS = {
	fetch: {
		code: (u) => `out.r = await fetch(${u}).then((r) => 'ok', (e) => e.name);`,
		file: 'd.txt',
	},
	'fetch-request': {
		code: (u) =>
			`try { out.r = await fetch(new Request(${u})).then(() => 'ok', (e) => e.name); } catch (e) { out.r = 'ctor ' + e.name; }`,
		file: 'd.txt',
	},
	xhr: {
		code: (u) =>
			`try { const x = new XMLHttpRequest(); x.open('GET', ${u}); x.send(); await new Promise((r) => { x.onloadend = r; setTimeout(r, 3000); }); out.r = x.status; } catch (e) { out.r = e.name; }`,
		file: 'd.txt',
	},
	beacon: {
		code: (u) =>
			`try { out.r = navigator.sendBeacon(${u}, 'x'); } catch (e) { out.r = e.name; }`,
		file: 'b.txt',
	},
	'event-source': {
		code: (u) =>
			`try { const e = new EventSource(${u}); await new Promise((r) => { e.onerror = r; e.onopen = r; setTimeout(r, 2000); }); e.close(); out.r = 'made'; } catch (e) { out.r = e.name; }`,
		file: 'e.txt',
	},
	'image-src': {
		code: (u) =>
			`const i = new Image(); i.src = ${u}; out.v = i.src; await new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 2000); });`,
		file: '0.png',
	},
	'image-set-attribute': {
		code: (u) =>
			`const i = document.createElement('img'); i.setAttribute('src', ${u}); out.v = i.src; document.body.append(i); await new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 2000); });`,
		file: '0.png',
	},
	'image-srcset': {
		code: (u) =>
			`const i = document.createElement('img'); i.srcset = ${u}; document.body.append(i); await new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 2000); }); out.v = i.currentSrc;`,
		file: '0.png',
	},
	'script-src': {
		code: (u) =>
			`const sc = document.createElement('script'); sc.src = ${u}; out.v = sc.src; document.head.append(sc); await new Promise((r) => { sc.onload = sc.onerror = r; setTimeout(r, 2000); });`,
		file: 's.js',
	},
	'link-stylesheet': {
		code: (u) =>
			`const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${u}; out.v = l.href; document.head.append(l); await new Promise((r) => { l.onload = l.onerror = r; setTimeout(r, 2000); });`,
		file: 's.css',
	},
	'audio-ctor': {
		code: (u) =>
			`const a = new Audio(${u}); out.v = a.src; await new Promise((r) => { a.onerror = a.oncanplay = r; setTimeout(r, 1500); });`,
		file: 'a.mp3',
	},
	'dynamic-import': {
		code: (u) => `out.r = await import(${u}).then(() => 'ok', (e) => e.name);`,
		file: 'm.js',
	},
	websocket: {
		code: (u) =>
			`try { const w = new WebSocket(${u}); await new Promise((r) => { w.onerror = w.onclose = w.onopen = r; setTimeout(r, 2000); }); out.r = 'made'; out.v = w.url; } catch (e) { out.r = e.name; }`,
		file: 'w',
	},
	'module-static-import': {
		code: (u) =>
			`const sc = document.createElement('script'); sc.type = 'module'; sc.textContent = 'import ' + JSON.stringify(${u}) + ';'; document.head.append(sc); await new Promise((r) => setTimeout(r, 1500));`,
		file: 'm.js',
	},
	'new-url': {
		code: (u) =>
			`try { out.v = new URL(${u}, document.baseURI).href; } catch (e) { out.v = e.name; }`,
		file: '0.png',
		observeOnly: true,
	},
	'anchor-href': {
		code: (u) =>
			`const a = document.createElement('a'); a.href = ${u}; out.v = [a.href, a.protocol, a.host, a.pathname, a.search, a.hash];`,
		file: '0.png',
		observeOnly: true,
	},
	'frame-src': {
		code: (u) => `frame.src = ${u}; await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'frame-location-assign': {
		code: (u) =>
			`try { frame.contentWindow.location.assign(${u}); } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'frame-location-replace': {
		code: (u) =>
			`try { frame.contentWindow.location.replace(${u}); } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'frame-location-href': {
		code: (u) =>
			`try { frame.contentWindow.location.href = ${u}; } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'frame-location-set': {
		code: (u) =>
			`try { frame.contentWindow.location = ${u}; } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'window-open-frame': {
		code: (u) =>
			`try { const w = window.open(${u}, frame.name); out.r = w === frame.contentWindow; } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'anchor-click-frame': {
		code: (u) =>
			`const a = document.createElement('a'); a.href = ${u}; a.target = frame.name; document.body.append(a); a.click(); await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'form-action-frame': {
		code: (u) =>
			`const f = document.createElement('form'); f.action = ${u}; f.method = 'get'; f.target = frame.name; document.body.append(f); try { f.submit(); } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
	'navigation-navigate': {
		code: (u) =>
			`try { const n = frame.contentWindow.navigation.navigate(${u}); n.committed.catch(() => {}); n.finished.catch(() => {}); } catch (e) { out.r = e.name; } await frameLoad();`,
		file: 'f.html',
		frame: true,
		navigates: true,
	},
};

function batchPage(s, made) {
	const blocks = made
		.map(
			(m) =>
				`run(${js(m.id)}, ${m.frame ? 'true' : 'false'}, async (out, frame, frameLoad) => { ${m.code} });`,
		)
		.join('\n');
	return `<!doctype html><html><head><meta charset="utf-8"><base href="${s.origin}/fz/">${headScript}</head><body>
<script>
const pending = [];
function run(id, wantsFrame, body) {
	const out = (window.__fz.obs[id] = {});
	let frame = null;
	let frameLoad = () => Promise.resolve();
	if (wantsFrame) {
		frame = document.createElement('iframe');
		frame.name = 'n' + id;
		frame.src = 'about:blank';
		document.body.append(frame);
		frameLoad = () => new Promise((r) => { frame.addEventListener('load', r, { once: true }); setTimeout(r, 2500); });
	}
	pending.push(Promise.resolve().then(() => body(out, frame, frameLoad)).catch((e) => { out.threw = e.name; }));
}
${blocks}
window.__fzReady = Promise.allSettled(pending);
</script>
${doneScript(s.origin, 800)}
</body></html>`;
}

const ONLY = process.env.FZ_ONLY ? new RegExp(process.env.FZ_ONLY) : null;

function build(s) {
	const specs = [];
	const sinks = Object.keys(SINKS);
	const navigating = sinks.filter((k) => SINKS[k].navigates);
	// every spelling through every call
	for (const sink of sinks)
		for (const spell of Object.keys(SPELLINGS)) specs.push({ sink, spell });
	// every javascript: spelling through every call that navigates
	for (const sink of navigating)
		for (const scheme of JS_SCHEMES) specs.push({ sink, scheme });
	// a seeded sample of spellings combined (one inside another's slot)
	const r = prng(SEED);
	const spells = Object.keys(SPELLINGS);
	for (let i = 0; i < 60 * SCALE; i++)
		specs.push({
			sink: r.pick(sinks),
			spell: r.pick(spells),
			twist: r.pick(['tab', 'case', 'c0', 'backslash']),
		});
	const made = [];
	for (const [n, spec] of specs.entries()) {
		const id = `u${n}`;
		const sink = SINKS[spec.sink];
		let url;
		if (spec.scheme) url = spec.scheme + payload(s, id);
		else {
			url = SPELLINGS[spec.spell](s, id, sink.file);
			if (spec.twist === 'tab') url = url.replace(/\//, '/\t');
			if (spec.twist === 'case')
				url = url
					.replace(/fz/, 'fz')
					.replace(/^(\w+):/, (m) => m.toUpperCase());
			if (spec.twist === 'c0') url = `\u0002 ${url}\u0003`;
			if (spec.twist === 'backslash') url = url.replace(/\/(?!\/)/g, '\\');
		}
		const tags = {
			sink: spec.sink,
			spell: spec.spell ?? null,
			scheme: spec.scheme ?? null,
			twist: spec.twist ?? null,
		};
		if (ONLY && !ONLY.test(JSON.stringify(tags))) continue;
		made.push({ id, code: sink.code(js(url)), frame: !!sink.frame, tags, url });
	}
	const files = {};
	const batches = [];
	for (let i = 0; i < made.length; i += PER_BATCH) {
		const slice = made.slice(i, i + PER_BATCH);
		for (const m of slice) {
			files[`/fz/${m.id}/m.js`] = {
				type: 'text/javascript',
				body: 'export {};',
			};
			files[`/fz/${m.id}/f.html`] = {
				type: 'text/html',
				body: '<!doctype html><title>f</title>',
			};
		}
		batches.push({
			id: `url${batches.length}`,
			page: batchPage(s, slice),
			files,
			cases: slice.map((m) => ({
				id: m.id,
				tags: m.tags,
				repro: `${JSON.stringify(m.tags)} ${m.code.replace(/^.*?\(/, '(').slice(0, 60)}... with ${JSON.stringify(m.url).replaceAll(s.origin, 'ORIGIN')}`,
			})),
		});
	}
	return batches;
}

// The findings of this group that are open on purpose (test/parserFuzz.mjs
// `knownOpen`). Every remaining one is a breakage (no escape, no leak): a
// call where the proxied result differs from native on an edge of URL
// parsing. Escapes were the import-specifier and getMime cases, now fixed.
const KNOWN_OPEN = {
	'embedded-credentials': {
		// a URL with userinfo (http://u:p@host): fetch, XHR, beacon and
		// EventSource forbid it (Chrome throws or drops), some navigations
		// strip it; STomp routes the URL and makes the request, so the
		// proxied call succeeds where native fails
		why: 'a URL with embedded credentials is routed and requested where Chrome forbids it (src/routeURL.ts / the inject URL sinks)',
		match: (c, f) => c.tags.spell === 'credentials' && f.kind === 'breakage',
	},
	'malformed-url': {
		// a URL Chrome cannot parse (a bad port, an unterminated IPv6 host, a
		// space in the host, an empty or percent-escaped host): native throws
		// or does not load; the proxy throws a TypeError at a different point
		// or resolves it differently. Per call, it does not abort the page.
		why: 'a malformed URL fails at a different point proxied than native (new URL in the inject URL sinks)',
		match: (c, f) =>
			c.tags.spell.startsWith('invalid') && f.kind === 'breakage',
	},
	'navigation-api': {
		// Navigation.navigate() in a proxied frame: the request native makes
		// is not made proxied (the base or the intercept differs)
		why: 'the Navigation API navigate() resolves or intercepts a URL differently under the proxy (src/inject/dom/modules/Navigate.ts)',
		match: (c, f) =>
			c.tags.sink === 'navigation-navigate' && f.kind === 'breakage',
	},
	'srcset-readback': {
		// img.srcset / currentSrc readback for odd candidate URLs (a tab or
		// newline inside, a bad descriptor, credentials): the parsed value
		// differs from native
		why: 'srcset candidate parsing and currentSrc readback differ from Chrome for odd URLs (src/inject/dom/modules/DOMAttributes.ts srcset)',
		match: (c, f) => c.tags.sink === 'image-srcset' && f.kind === 'breakage',
	},
	'frame-navigation-path': {
		// a frame navigation (location.replace/href/set, window.open, a
		// link's click, a form, a static import) whose resolved URL differs
		// from native on a parsing edge (a fragment, a query with reserved
		// characters, scheme-only relative, whitespace)
		why: 'a frame navigation or module resolution differs from Chrome on a URL-parsing edge (src/inject/dom/modules/Location.ts, Navigate.ts, src/scriptRoutes.ts)',
		match: (c, f) =>
			f.kind === 'breakage' &&
			/^(frame-|window-open|anchor-click|form-action|module-static|dynamic-import|link-stylesheet|audio-ctor|script-src|image-set-attribute|image-src|new-url|anchor-href|fetch|xhr|beacon|event-source|websocket|fetch-request)/.test(
				c.tags.sink,
			),
	},
};

await runDifferential({
	name: 'parse-url',
	build,
	knownOpen: KNOWN_OPEN,
	budget: Number(process.env.FZ_BUDGET || 420000),
	native: process.env.FZ_NATIVE === '1',
});
