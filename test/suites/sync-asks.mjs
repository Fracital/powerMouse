// In Chrome, what a page asks for synchronously sends nothing to the host's
// server. A document of the synchronous bridge (src/inject/dom/modules/
// Sync.ts) asks the service worker for its answer with a synchronous request
// of its own while it does not know whether the browser lets the worker
// answer one (src/inject/dom/syncAnswer.ts): Firefox does, Chrome and WebKit
// send it to the network. That ask went to `<address>xhr?a=<id>`, which the
// host's server does not serve: in a fresh profile every document before the
// worker heard of it had a 404 in its console, logged at the bridge's code
// in dist/rewriterLib.js (about 7 in a run of the extension audit, read as a
// 404 of the rewriter library). A document finds out now with a HEAD request
// for the rewriter library, a file the host serves, which the worker answers
// itself when it gets it.
//
// The suite's HTTP/1 server serves a page that makes a synchronous
// XMLHttpRequest, reads and writes localStorage and document.cookie, and
// says what it read in its title. Through the demo, in each mode and in a
// context of its own (a fresh profile: nothing learned), the page reads
// what it reads natively and no request of its documents or the worker's
// is answered by the host's server with an error.
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

const PAGE = `<!doctype html><title>PAGE</title>
<script>
const request = new XMLHttpRequest();
request.open('GET', '/data.txt', false);
request.send();
localStorage.setItem('kept', 'yes');
document.cookie = 'eaten=1; path=/';
document.title = [
	'DONE',
	request.status,
	request.responseText,
	localStorage.getItem('kept'),
	localStorage.getItem('never-written'),
	document.cookie,
].join(' ');
</script>`;

const server = createServer((req, res) => {
	const { pathname } = new URL(req.url, 'http://x');
	if (pathname === '/page.html') {
		res.writeHead(200, {
			'content-type': 'text/html',
			'cache-control': 'no-store',
		});
		return res.end(PAGE);
	}
	if (pathname === '/data.txt') {
		res.writeHead(200, {
			'content-type': 'text/plain',
			'cache-control': 'no-store',
		});
		return res.end('data');
	}
	res.writeHead(404);
	res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_OF = `http://127.0.0.1:${server.address().port}/page.html`;
const WANT = 'DONE 200 data yes eaten=1';

const browser = await launch();

/** the title of the newest frame showing the page, once it is done */
async function report(page) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const frame of page.frames().reverse()) {
			const title = await frame.title().catch(() => '');
			if (title.startsWith('DONE')) return title;
		}
	}
	return null;
}

const native = await browser.newPage();
await native.goto(URL_OF);
const want = await report(native);
await native.context().close();
ok('natively, the page reads what it wrote', want === WANT, want);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// what the host's own server answered with an error (no service worker
	// answered it), from any page, frame or worker of the context
	const failed = [];
	// and the questions whether a synchronous request reaches the worker
	// that the host's server answered (Chrome sends them past the worker)
	const probes = [];
	page.context().on('response', (response) => {
		if (response.fromServiceWorker()) return;
		const line = `${response.status()} ${response.request().method()} ${response.url()}`;
		if (response.status() >= 400) failed.push(line);
		else if (response.request().headers()['x-stomp-sync-probe'])
			probes.push(line);
	});
	await submitLanding(page, URL_OF);
	const got = await report(page);
	ok(
		`${mode}: the page reads as natively`,
		got === want,
		`native ${want}, proxied ${got}`,
	);
	// the bridge's own requests after the page's (a late ask, the worker told)
	await sleep(1000);
	const asks = failed.filter((line) =>
		new URL(line.split(' ')[2]).pathname.endsWith('/xhr'),
	);
	ok(
		`${mode}: no synchronous ask of the bridge reaches the host's server`,
		asks.length === 0,
		`${asks.join(', ')} (questions the host answered: ${probes.join(', ') || 'none'})`,
	);
	// the worker heard what the browser does: the next document asks nothing
	const before = probes.length;
	await submitLanding(page, URL_OF);
	const again = await report(page);
	await sleep(1000);
	ok(
		`${mode}: a document after the worker heard reads as natively and asks nothing`,
		again === want && probes.length === before,
		`proxied ${again}, questions after the first: ${probes.slice(before).join(', ') || 'none'}`,
	);
	ok(
		`${mode}: the host's server answers no request with an error`,
		failed.length === 0,
		failed.join(', '),
	);
	await page.context().close();
}

server.close();
await done(browser);
