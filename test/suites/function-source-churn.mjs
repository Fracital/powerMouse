// A page that evaluates many distinct scripts (eval or new Function in a
// loop, a challenge script retried every second, an app that injects
// scripts) must not keep each one's text for its life. The inject keeps the
// text of every script it rewrites whose functions read back as written
// (src/functionSource.ts), and kept all of them: COUNT distinct evals of
// PAD characters each held about COUNT * PAD bytes after a GC, where
// natively a script's text goes with its last function. Measured as the JS
// heap after a GC over that before the churn, against the same page loaded
// natively, in same-origin mode, where the proxied frame shares the page's
// renderer and its heap. Each function still reachable after the churn
// reads as it does natively: the results of eval, indirect eval and new
// Function made before it and never read until after it, a function nested
// in one of those, functions of the churn the page kept, a function read
// once before the churn, a function of a script element the page injected
// and of a handler attribute, and functions of an inline script of the
// page's markup (which hands its text over in its own source). A function
// of evaluated code that nothing of the page's the inject sees reaches (a
// direct eval's value, one evaluated code stores) and whose text the table
// let go reads as its rewrite without the marks: as natively where the
// rewriter changed nothing in it (checked), not where it did (reported).
import { createServer } from 'node:http';
import {
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const MB = 1048576;
const COUNT = 10000;
const PAD = 4000;

const PAGE =
	'<!doctype html><html><head><title>SOURCE-CHURN</title></head><body>' +
	'<p>a page that evaluates many distinct scripts</p><script>\n' +
	'function inlineEarly(a) { return a + 1; }\n' +
	// made before the churn, none read before it
	"window.evalEarly = (0, eval)('(function evalEarly(a) {\\n  return function evalEarlyInner(b) { return a + b; };\\n})');\n" +
	'window.evalEarlyInner = window.evalEarly(1);\n' +
	"window.directEarly = eval('(function directEarly(a) { return a  *  3; })');\n" +
	"window.fnEarly = new Function('a', 'return function fnEarlyInner(b) { return a  *  b; };');\n" +
	'window.fnEarlyInner = window.fnEarly(2);\n' +
	// an injected script's and a handler attribute's, of elements that stay
	"var injected = document.createElement('script');\n" +
	"injected.textContent = 'function injectedEarly(a) { return a  -  1; }';\n" +
	'document.head.append(injected);\n' +
	"window.button = document.createElement('button');\n" +
	"window.button.setAttribute('onclick', 'return  1 + 1;');\n" +
	'document.body.append(window.button);\n' +
	// one nothing of the page's that the inject sees reaches
	"(0, eval)('window.storedPlain = function storedPlain() { return  2; }; 0');\n" +
	"(0, eval)('window.storedRouted = function storedRouted() { return  top.location.href; }; 0');\n" +
	// read once before the churn
	"window.readEarly = eval('(function readEarly() { return  1; })');\n" +
	'window.readBefore = String(window.readEarly);\n' +
	`var PAD = 'x'.repeat(${PAD});\n` +
	'window.churn = function (from, count) {\n' +
	'  var live = window.live || (window.live = []);\n' +
	'  for (var i = from; i < from + count; i++) {\n' +
	"    var body = 'return \"' + PAD + i + '\" +  a;';\n" +
	"    var text = '(function churn' + i + '(a) { ' + body + ' })';\n" +
	'    var made = i % 3 === 0 ? eval(text)\n' +
	'      : i % 3 === 1 ? (0, eval)(text)\n' +
	"      : new Function('a', body);\n" +
	'    if (i % 1000 === 0) live.push(made);\n' +
	'  }\n' +
	'  return live.length;\n' +
	'};\n' +
	'window.sources = function () {\n' +
	'  var out = {\n' +
	'    inlineEarly: String(inlineEarly),\n' +
	'    evalEarly: String(window.evalEarly),\n' +
	'    evalEarlyInner: String(window.evalEarlyInner),\n' +
	'    directEarly: String(window.directEarly),\n' +
	'    fnEarly: String(window.fnEarly),\n' +
	'    fnEarlyInner: String(window.fnEarlyInner),\n' +
	'    readEarly: String(window.readEarly),\n' +
	'    readBefore: window.readBefore,\n' +
	'    injectedEarly: String(window.injectedEarly),\n' +
	'    handler: String(window.button.onclick),\n' +
	'    storedPlain: String(window.storedPlain),\n' +
	'    storedRouted: String(window.storedRouted),\n' +
	'  };\n' +
	'  (window.live || []).forEach(function (f, i) {\n' +
	"    var s = String(f); out['live' + i] = s.length + ':' + s.slice(0, 40) + s.slice(-40);\n" +
	'  });\n' +
	'  return out;\n' +
	'};\n' +
	'window.__ready = true;\n' +
	'</script></body></html>';

const server = createServer((req, res) => {
	const path = new URL(req.url, 'http://x/').pathname;
	res.writeHead(200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(
		path === '/churn' ? PAGE : '<!doctype html><title>EMPTY</title><p>empty',
	);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;
const ROUTE = /\/stomp\/[\w-]+\/html\//;

/** the renderer's JS heap once a full GC has run */
async function heapAfterGC(cdp) {
	for (let i = 0; i < 4; i++) {
		await cdp.send('HeapProfiler.collectGarbage');
		await sleep(150);
	}
	return (await cdp.send('Runtime.getHeapUsage')).usedSize;
}

async function until(get, pred, timeout = 60000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await get().catch(() => null);
		if (pred(value)) return value;
		await sleep(250);
	}
	return null;
}

/**
 * The heap the churn leaves after a GC, twice over (COUNT scripts each
 * time), and the sources of the functions still reachable after it
 */
async function measure(page, frame) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('HeapProfiler.enable');
	const ready = !!(await until(
		() => frame().evaluate(() => window.__ready === true),
		(value) => value === true,
	));
	await sleep(1000);
	const before = await heapAfterGC(cdp);
	const started = Date.now();
	await frame().evaluate((count) => window.churn(0, count), COUNT);
	const once = await heapAfterGC(cdp);
	await frame().evaluate((count) => window.churn(count, count), COUNT);
	const twice = await heapAfterGC(cdp);
	const ms = Date.now() - started;
	await cdp.detach();
	const sources = ready ? await frame().evaluate(() => window.sources()) : {};
	return { ready, once: once - before, twice: twice - before, ms, sources };
}

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}churn`);
const native = await measure(nativePage, () => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively, the page runs',
	native.ready,
	JSON.stringify(native).slice(0, 300),
);

const page = await openDemo(browser, PROXY);
await submitLanding(page, `${ORIGIN}churn`);
let current = null;
const frame = () => {
	const found = page.frames().findLast((f) => ROUTE.test(f.url()));
	if (found) current = found;
	return current ?? page.mainFrame();
};
await until(
	async () => frame() !== page.mainFrame(),
	(value) => value === true,
);
const proxied = await measure(page, frame);
ok('proxied, the page runs', proxied.ready);

const mb = (bytes) => (bytes / MB).toFixed(2);
const held = (run) => `${mb(run.once)} MB, ${mb(run.twice)} MB`;
console.log(
	`heap over the page's before the churn, after ${COUNT} and ${2 * COUNT} scripts of ${PAD} characters: ` +
		`proxied ${held(proxied)} (${proxied.ms} ms), native ${held(native)} (${native.ms} ms)`,
);
// the texts the inject keeps are bounded (src/functionSource.ts KEPT_UNITS,
// 8 Mi UTF-16 units): what the proxied page holds over the native one is
// at most that, and a second churn as long as the first adds nothing to it
ok(
	'the page keeps a bounded part of the texts it evaluated',
	proxied.ready &&
		native.ready &&
		proxied.twice - native.twice < 12 * MB &&
		proxied.twice - proxied.once < 3 * MB,
	`proxied over native: ${mb(proxied.once - native.once)} MB after ${COUNT}, ${mb(proxied.twice - native.twice)} MB after ${2 * COUNT} (texts ${mb(2 * COUNT * PAD)} MB)`,
);
// (a function made inside evaluated code and kept where the inject sees
// nothing of it, never read before the churn: its text is one of the oldest
// and nothing pinned it, so it reads as its rewrite without the marks,
// which is the page's text only where the rewriter changed nothing in it,
// src/functionSource.ts unmarked)
const LIMITED = ['storedRouted'];
for (const name of LIMITED)
	console.log(
		`${name} after the churn (not checked): ${JSON.stringify(proxied.sources[name]).slice(0, 120)}`,
	);
for (const name of Object.keys(native.sources))
	if (!LIMITED.includes(name))
		ok(
			`${name} reads as natively after the churn`,
			proxied.sources[name] === native.sources[name],
			`${JSON.stringify(native.sources[name]).slice(0, 200)} -> ${JSON.stringify(proxied.sources[name]).slice(0, 200)}`,
		);

server.close();
server.closeAllConnections();
await done(browser);
