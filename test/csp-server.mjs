// The Content-Security-Policy side of the fixture (csp-* suites): a
// document under the policies its query names, which runs probes and
// records what each did and the violation events it saw.
//
//   /csp/doc?p=<policy>&ro=<policy>&m=<policy>&probes=<a,b>&h=<how>
//     p:  a Content-Security-Policy header (repeatable: one header each)
//     ro: a Content-Security-Policy-Report-Only header (repeatable)
//     m:  a <meta http-equiv="Content-Security-Policy"> in the head
//         (repeatable)
//     mro: a <meta http-equiv="Content-Security-Policy-Report-Only"> in the
//         head (repeatable; the browser ignores it)
//     probes: the names of test/pages/csp-probes.js's probes to run
//     s:  styles in the head, one carrying nonce="probes" (markup-styles)
//     js: `tt` for test/pages/csp-tt-probes.js's (Trusted Types) instead,
//         `worker` for test/pages/csp-worker-probes.js's (the workers'
//         connections), after a script that leaves the worker's text on
//         the window for the blob: and data: workers
//     h:  how the probe script is included, so that the policy lets it
//         run: `self` (a script element whose src is /csp/probes.js, the
//         default), `nonce` (that element with nonce="probes"), `inline`
//         (its text inline), `inline-nonce`, `inline-hash` (inline, and the
//         sha256 of its text is in the X-Probe-Hash header)
//     fs: the case in a frame with this sandbox attribute instead (a page
//         under no policy whose iframe is this URL without `fs`)
//   /csp/probes.js       the probes (test/pages/csp-probes.js; `?js=tt` the
//                        csp-tt-probes.js ones)
//   /csp/ok              text "ok", for any origin (CORS *)
//   /csp/run.js          a script that sets window.__ran to 1
//   /csp/sse             an event stream of one message, "sse"
//   /csp/img.png         a 1x1 PNG
//   /csp/worker.js       a worker that posts "worker" back
//   /csp/cw.js?wp=<policy>&wro=<policy>&si=<url>  the csp-workers suite's
//                        worker (test/pages/csp-worker.js) under the
//                        policies of its own response's headers
//                        (repeatable), a module worker's after a static
//                        import of each `si`
//                        `&rk=<key>` adds a report-uri of /csp/report
//                        under that key to each (`&rt` a report-to of it)
//   /csp/wrun.js         a script or module that counts self.__ran up
//   /csp/report?k=<key>  takes a report (the log of its key has it)
//   /csp/cw-text.js      a script that leaves that worker's text on the
//                        global as `__cspWorkerText`
//   /csp/frame.html      a document that posts "frame" to its parent
//   /csp/font.woff       a font (test/pages/blank-font.ttf)
//   /csp/style.css       a stylesheet that sets --csp-style on :root
//   /csp/sound.wav       a short silent WAV
//   /csp/manifest.json   a web app manifest
//   /csp/to?u=<url>      a 302 to `u`
//   /csp/log?k=<key>     the paths that reached /csp/ under that key
//                        (`k=` on any of them); `&clear` forgets them
//
// The navigation probes (csp-navigation, test/pages/csp-navigation-probes.js):
//   /csp/doc?s=nav&b=<href>  the navigation probes' script first in the head
//                        (it runs them once the document is parsed), then
//                        the metas, then a <base href> for each `b`
//   /csp/nav-probes.js   the navigation probes
//   /csp/framed?p=..     a document under the policies p, ro and m name
//                        (as /csp/doc's) that posts "framed" to its parent
//   /csp/go?u=<url>&how=<location|link|form>  a document that navigates
//                        itself to `u` once loaded (`&watch` posts what its
//                        navigate events name to its parent)
//   /csp/form            a form's destination: posts "arrived <method>
//                        q=<q>" to its parent and its opener
//
// test/fixture.mjs calls `csp(req, res)` first and serves the rest.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrotliCompress } from 'node:zlib';

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
	if (url.pathname.startsWith('/csp/sbx')) return sandboxed(url, res);
	const query = url.searchParams;
	const key = query.get('k');
	if (key !== null && url.pathname !== '/csp/log') {
		if (!logs.has(key)) logs.set(key, []);
		// (a layout's script by its name)
		logs
			.get(key)
			.push(
				url.pathname === '/csp/ran.js'
					? `${url.pathname}?n=${query.get('n')}`
					: url.pathname,
			);
	}
	res.setHeader('cache-control', 'no-store');
	res.setHeader('access-control-allow-origin', '*');
	const send = (type, body) => {
		res.setHeader('content-type', type);
		res.end(body);
	};
	switch (url.pathname) {
		case '/csp/doc': {
			if (query.has('fs')) {
				const inner = new URLSearchParams(query);
				inner.delete('fs');
				send(
					'text/html; charset=utf-8',
					`<!doctype html><html><head><title>CSP FRAME</title></head><body><iframe sandbox="${attribute(query.get('fs'))}" src="${attribute(`/csp/doc?${inner}`)}"></iframe></body></html>`,
				);
				return true;
			}
			if (query.has('l')) {
				layout(req, res, query);
				return true;
			}
			const js = query.get('js');
			const probes = readFileSync(`${pages}${probeFile(js)}`, 'utf8');
			const src =
				js === 'tt' || js === 'worker'
					? `/csp/probes.js?js=${js}`
					: '/csp/probes.js';
			const metas = policies(res, query);
			if (query.get('s') === 'nav') {
				const bases = query
					.getAll('b')
					.map((href) => `<base href="${attribute(href)}">`)
					.join('\n');
				send(
					'text/html; charset=utf-8',
					`<!doctype html><html><head><script src="/csp/nav-probes.js"></script>\n${metas}\n${bases}\n<title>CSP NAVIGATION</title></head><body><p id="after">after</p></body></html>`,
				);
				return true;
			}
			const how = query.get('h') ?? 'self';
			const text = `\n${probes}\n`;
			if (how === 'inline-hash')
				res.setHeader(
					'x-probe-hash',
					`sha256-${createHash('sha256').update(text).digest('base64')}`,
				);
			const script =
				(js === 'worker' ? '<script src="/csp/cw-text.js"></script>' : '') +
				(how === 'self'
					? `<script src="${src}"></script>`
					: how === 'nonce'
						? `<script nonce="probes" src="${src}"></script>`
						: how === 'inline-nonce'
							? `<script nonce="probes">${text}</script>`
							: `<script>${text}</script>`);
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
				readFileSync(`${pages}${probeFile(query.get('js'))}`),
			);
			return true;
		case '/csp/cw.js': {
			// `rk`: each policy reports to /csp/report under that key, by
			// report-uri, or by report-to (`rt`)
			const rk = query.get('rk');
			const reporting = rk
				? query.has('rt')
					? '; report-to cw'
					: `; report-uri /csp/report?k=${encodeURIComponent(rk)}`
				: '';
			if (rk && query.has('rt'))
				res.setHeader(
					'reporting-endpoints',
					`cw="/csp/report?k=${encodeURIComponent(rk)}"`,
				);
			for (const policy of query.getAll('wp'))
				res.appendHeader('content-security-policy', policy + reporting);
			for (const policy of query.getAll('wro'))
				res.appendHeader(
					'content-security-policy-report-only',
					policy + reporting,
				);
			send(
				'text/javascript; charset=utf-8',
				query
					.getAll('si')
					.map((url) => `import ${JSON.stringify(url)};\n`)
					.join('') + readFileSync(`${pages}csp-worker.js`, 'utf8'),
			);
			return true;
		}
		case '/csp/report':
			// (what reached it is in the log of its key)
			req.resume();
			res.statusCode = 204;
			res.end();
			return true;
		case '/csp/cw-text.js':
			send(
				'text/javascript; charset=utf-8',
				`self.__cspWorkerText = ${JSON.stringify(readFileSync(`${pages}csp-worker.js`, 'utf8')).replace(/</g, '\\u003c')};`,
			);
			return true;
		case '/csp/ok':
			send('text/plain', 'ok');
			return true;
		case '/csp/run.js':
			send('text/javascript', 'window.__ran = 1;');
			return true;
		case '/csp/ran.js':
			send('text/javascript', ranText(query.get('n') ?? ''));
			return true;
		case '/csp/wrun.js':
			send('text/javascript', 'self.__ran = (self.__ran ?? 0) + 1;');
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
			if (query.has('clear')) logs.delete(key);
			return true;
		case '/csp/nav-probes.js':
			send(
				'text/javascript; charset=utf-8',
				readFileSync(`${pages}csp-navigation-probes.js`),
			);
			return true;
		case '/csp/framed':
			send(
				'text/html; charset=utf-8',
				`<!doctype html><html><head>${policies(res, query)}<title>framed</title></head><body><script>parent.postMessage("framed", "*");</script></body></html>`,
			);
			return true;
		case '/csp/go': {
			const to = JSON.stringify(query.get('u') ?? '/csp/ok');
			const how = JSON.stringify(query.get('how') ?? 'location');
			// `watch`: its navigate events' destinations are posted to its parent
			const watch = query.has('watch')
				? "window.navigation?.addEventListener('navigate', (event) => parent.postMessage('navigate ' + event.destination.url + ' ' + event.navigationType + (event.formData ? ' with a form' : ''), '*')); "
				: '';
			send(
				'text/html; charset=utf-8',
				`<!doctype html><title>go</title><body><script>onload = () => setTimeout(() => { ${watch}const to = ${to}.replace(/</g, ''); const how = ${how}; if (how === 'link') { const a = document.createElement('a'); a.href = to; document.body.append(a); a.click(); } else if (how === 'form') { const f = document.createElement('form'); f.method = 'post'; f.action = to; document.body.append(f); f.submit(); } else if (how === 'replace') location.replace(to); else location.href = to; });</script></body>`,
			);
			return true;
		}
		case '/csp/form': {
			const arrived = (q) => {
				send(
					'text/html; charset=utf-8',
					`<!doctype html><title>arrived</title><script>for (const w of new Set([parent, opener])) if (w && w !== window) w.postMessage(${JSON.stringify(`arrived ${req.method} q=${q}`).replace(/</g, '\\u003c')}, "*");</script>`,
				);
			};
			if (req.method !== 'POST') {
				arrived(query.get('q'));
				return true;
			}
			const chunks = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.on('end', () =>
				arrived(new URLSearchParams(Buffer.concat(chunks).toString()).get('q')),
			);
			return true;
		}
	}
	return false;
}

/** the probes file of a /csp/doc page whose `js` is `js` */
const probeFile = (js) =>
	js === 'tt'
		? 'csp-tt-probes.js'
		: js === 'worker'
			? 'csp-worker-probes.js'
			: 'csp-probes.js';

/** the policies a /csp/ document's query names: its headers set, its metas returned */
function policies(res, query) {
	for (const policy of query.getAll('p'))
		res.appendHeader('content-security-policy', policy);
	for (const policy of query.getAll('ro'))
		res.appendHeader('content-security-policy-report-only', policy);
	for (const policy of query.getAll('pp'))
		res.appendHeader('permissions-policy', policy);
	const meta = (name, equiv) =>
		query
			.getAll(name)
			.map(
				(policy) =>
					`<meta http-equiv="${equiv}" content="${attribute(policy)}">`,
			)
			.join('');
	return (
		meta('m', 'Content-Security-Policy') +
		meta('mro', 'Content-Security-Policy-Report-Only')
	);
}

/** the text of a layout's script that says `name` ran (its hash is the one a policy names) */
export const ranText = (name) =>
	`__ran(${JSON.stringify(String(name).replace(/[^\w-]/g, ''))})`;

/**
 * A /csp/doc page laid out by its `l` query (csp-meta-scripts): the
 * recorder first in the head (an inline script with nonce="probes", before
 * any meta, so it runs under every meta), then each comma-separated token
 * of `l` in order, then the body's end. The recorder counts each script that
 * ran (`__ran(name)`), the load and error events of each script element
 * (`data-n`), the document's violations and the csp-violation reports a
 * ReportingObserver is handed, and puts them on `window.__csp` a moment
 * after load, as the probes do (test/csp-lib.mjs compareCases). The probe
 * `reports` answers the reports.
 *
 *   meta / meta:<i>  every `m` policy's meta here, or the i-th one's
 *   mi:<i>           an inline script (nonce="probes") that appends the
 *                    i-th `m` policy's meta to the head
 *   gap              2 KB of comment, then the response pauses 400 ms (the
 *                    head is read on in a later piece)
 *   body             the head ends and the body starts here (else at the end)
 *   i:<n>            an inline script `__ran("<n>")`, no nonce
 *   in:<n> / ix:<n>  the same with nonce="probes" / nonce="wrong"
 *   e:<n> / en:<n>   a script by /csp/ran.js?n=<n>, without / with the nonce
 *   eo:<n>           the same of the other origin, without a nonce
 *   di:<n> / de:<n>  an inline script (nonce="probes") that inserts an
 *                    inline / external script of <n> after itself, no nonce
 *   wi:<n> / we:<n>  the same by document.write
 *   sty:<n>          an inline <style id="<n>"> that sets --<n> on the root
 * With `br` the page goes brotli-compressed, each piece flushed.
 */
function layout(req, res, query) {
	const host = req.headers.host ?? '';
	const other = `http://${host.includes('127.0.0.1') ? host.replace('127.0.0.1', 'localhost') : host.replace('localhost', '127.0.0.1')}`;
	const metas = query.getAll('m');
	const meta = (policy) =>
		`<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">`;
	const helper = (code) => `<script nonce="probes">{ ${code} }</script>`;
	// (under the page's `k`, the log has the scripts that reached the server)
	const logKey = query.get('k');
	const external = (name, origin = '') =>
		`${origin}/csp/ran.js?n=${encodeURIComponent(name)}${logKey === null ? '' : `&k=${encodeURIComponent(logKey)}`}`;
	const parts = [''];
	let body = false;
	for (const token of (query.get('l') ?? '').split(',').filter(Boolean)) {
		const colon = token.indexOf(':');
		const kind = colon === -1 ? token : token.slice(0, colon);
		const arg = colon === -1 ? '' : token.slice(colon + 1);
		const n = attribute(arg);
		const add = (markup) => (parts[parts.length - 1] += markup);
		switch (kind) {
			case 'meta':
				add(arg ? meta(metas[Number(arg)] ?? '') : metas.map(meta).join(''));
				break;
			case 'mi':
				add(
					helper(
						`const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = ${JSON.stringify(metas[Number(arg)] ?? '').replace(/</g, '\\u003c')}; document.head.append(m);`,
					),
				);
				break;
			case 'sty':
				add(`<style id="${n}">:root{--${n}:1}</style>`);
				break;
			case 'gap':
				add(`<!--${'.'.repeat(2048)}-->`);
				parts.push('');
				break;
			case 'body':
				add('</head><body>');
				body = true;
				break;
			case 'i':
				add(`<script data-n="${n}">${ranText(arg)}</script>`);
				break;
			case 'in':
				add(`<script data-n="${n}" nonce="probes">${ranText(arg)}</script>`);
				break;
			case 'ix':
				add(`<script data-n="${n}" nonce="wrong">${ranText(arg)}</script>`);
				break;
			case 'e':
				add(
					`<script data-n="${n}" src="${attribute(external(arg))}"></script>`,
				);
				break;
			case 'en':
				add(
					`<script data-n="${n}" nonce="probes" src="${attribute(external(arg))}"></script>`,
				);
				break;
			case 'eo':
				add(
					`<script data-n="${n}" src="${attribute(external(arg, other))}"></script>`,
				);
				break;
			case 'di':
			case 'de':
				add(
					helper(
						`const s = document.createElement('script'); s.dataset.n = ${JSON.stringify(arg)}; ${kind === 'di' ? `s.text = ${JSON.stringify(ranText(arg))}` : `s.src = ${JSON.stringify(external(arg))}`}; document.currentScript.after(s);`,
					),
				);
				break;
			case 'wi':
			case 'we':
				add(
					helper(
						`document.write(${JSON.stringify(kind === 'wi' ? `<script data-n="${n}">${ranText(arg)}</script>` : `<script data-n="${n}" src="${attribute(external(arg))}"></script>`).replace(/<\//g, '<\\/')});`,
					),
				);
				break;
		}
	}
	if (!body) parts[parts.length - 1] += '</head><body>';
	parts[parts.length - 1] += '<p id="end">end</p></body></html>';
	for (const policy of query.getAll('p'))
		res.appendHeader('content-security-policy', policy);
	for (const policy of query.getAll('ro'))
		res.appendHeader('content-security-policy-report-only', policy);
	res.setHeader('content-type', 'text/html; charset=utf-8');
	const recorder = readFileSync(`${pages}csp-meta-recorder.js`, 'utf8');
	parts[0] = `<!doctype html><html><head><script nonce="probes">${recorder}</script><title>CSP META</title>${parts[0]}`;
	let out = res;
	if (query.has('br')) {
		res.setHeader('content-encoding', 'br');
		out = createBrotliCompress();
		out.pipe(res);
	}
	const send = (index) => {
		if (index === parts.length - 1) return out.end(parts[index]);
		out.write(parts[index]);
		out.flush?.();
		setTimeout(() => send(index + 1), 400);
	};
	send(0);
}

// The `sandbox` directive's pages (csp-sandbox suite):
//
//   /csp/sbx?p=<policy>&ro=..&m=..&k=<key>&role=<name>&probes=<a,b>
//            &b=noscript&frame=<url>&fs=<sandbox>
//     a document under those policies (as /csp/doc's) that runs the
//     probe groups of test/pages/csp-sandbox-probes.js and sends what
//     each did to /csp/sbx-put under `role`; `b=noscript` adds markup
//     whose loads say which of its scripts ran; `frame` an iframe of that
//     URL, sandboxed by `fs` when given
//   /csp/sbx-probes.js       the probes
//   /csp/sbx-run.js?k&n      a script that puts `n` = "ran"
//   /csp/sbx-put?k&n&v       keeps `v` as `n` under `k` (a 1x1 PNG)
//   /csp/sbx-get?k           what was kept under `k`, as JSON
const kept = new Map();
function sandboxed(url, res) {
	const query = url.searchParams;
	const key = query.get('k') ?? 'x';
	res.setHeader('cache-control', 'no-store');
	res.setHeader('access-control-allow-origin', '*');
	const send = (type, body) => {
		res.setHeader('content-type', type);
		res.end(body);
	};
	const put = (name, value = '1') =>
		`/csp/sbx-put?${new URLSearchParams({ k: key, n: name, v: value })}`;
	switch (url.pathname) {
		case '/csp/sbx': {
			for (const policy of query.getAll('p'))
				res.appendHeader('content-security-policy', policy);
			for (const policy of query.getAll('ro'))
				res.appendHeader('content-security-policy-report-only', policy);
			const role = query.get('role') ?? 'top';
			const metas = query
				.getAll('m')
				.map(
					(policy) =>
						`<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">`,
				)
				.join('');
			const noscript =
				query.get('b') === 'noscript'
					? `<img src="${attribute(put(`${role} parsed`))}">` +
						`<script>new Image().src = ${JSON.stringify(put(`${role} inline script`))};</script>` +
						`<script src="${attribute(`/csp/sbx-run.js?${new URLSearchParams({ k: key, n: `${role} external script` })}`)}"></script>` +
						`<img src="/csp/sbx-none.png" onerror="${attribute(`new Image().src = ${JSON.stringify(put(`${role} onerror`))}`)}">` +
						`<noscript><img src="${attribute(put(`${role} noscript`))}"></noscript>`
					: '';
			const frame = query.get('frame');
			const sandbox = query.get('fs');
			const iframe =
				frame === null
					? ''
					: `<iframe id="f" src="${attribute(frame)}"${sandbox === null ? '' : ` sandbox="${attribute(sandbox)}"`}></iframe>`;
			send(
				'text/html; charset=utf-8',
				`<!doctype html><html><head>${metas}<title>CSP SANDBOX</title></head><body data-k="${attribute(key)}" data-role="${attribute(role)}">${noscript}${iframe}<script src="/csp/sbx-probes.js"></script><img src="${attribute(put(`${role} end`))}"></body></html>`,
			);
			return true;
		}
		case '/csp/sbx-probes.js':
			send(
				'text/javascript; charset=utf-8',
				readFileSync(`${pages}csp-sandbox-probes.js`),
			);
			return true;
		case '/csp/sbx-run.js':
			send(
				'text/javascript',
				`new Image().src = ${JSON.stringify(put(query.get('n') ?? 'script', 'ran'))};`,
			);
			return true;
		case '/csp/sbx-put': {
			if (!kept.has(key)) kept.set(key, {});
			kept.get(key)[query.get('n') ?? ''] = query.get('v') ?? '';
			send('image/png', PNG);
			return true;
		}
		case '/csp/sbx-get':
			send('application/json', JSON.stringify(kept.get(key) ?? {}));
			return true;
	}
	res.statusCode = 404;
	res.end();
	return true;
}
