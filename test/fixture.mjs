// Fixture site for the suites: pages that try to notice or escape the frame.
// Served on 127.0.0.1, so the demo server needs WISP_ALLOW_LOOPBACK=1 (the
// runner sets it). `node test/fixture.mjs [port]` runs it on its own.
import { createServer } from 'node:http';

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
t('outerEqualsInner', () => outerWidth === innerWidth && outerHeight === innerHeight);
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
<script>
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

const PAGES = {
	'/escape.html': ESCAPE,
	'/': TARGETS,
	'/dyn': DYN,
};

export function startFixture(port = 8084) {
	const server = createServer((req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		const path = new URL(req.url, 'http://x').pathname;
		if (path.startsWith('/landed'))
			return res.end('<title>LANDED</title><h1>landed</h1>');
		res.end(PAGES[path] ?? '<title>other</title>other');
	});
	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => resolve(server));
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
