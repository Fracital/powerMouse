// The HTTP cache (src/server/cache.ts) walks its store to count and evict
// it once it is over its 50 MB budget: every entry listed, each one's
// headers read. A write that found the store over budget used to start a
// walk of its own and wait for it, so a page full of cacheable loads made
// one walk per load, overlapping by the hundred, each holding a Request and
// a Response for every entry while it read them one by one: a browse of 30
// sites held 1.4 million Requests and 1.3 GB in the worker, which never
// caught up. One walk runs at a time now, after the write is done. A page
// here loads 120 MB of cacheable resources (480 of 256 KB); right after,
// the worker holds about one walk's Requests, not a walk's per load, and a
// resource it kept loads again at once (natively, from the browser's
// cache), not after the walks.
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
import { workerMemory } from '../worker-memory.mjs';

const KB = 256;
const LOADS = 480;
const body = Buffer.alloc(KB * 1024, 97);

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>CACHE WALKS</title><p>cache walks');
	} else if (url.pathname === '/asset') {
		res.writeHead(200, {
			'content-type': 'application/octet-stream',
			'content-length': body.length,
			'cache-control': 'max-age=3600',
			etag: `"${url.searchParams.get('i')}"`,
		});
		res.end(body);
	} else {
		res.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in a page: LOADS cacheable resources, 20 at a time */
const fill = async ({ origin, run, loads }) => {
	for (let batch = 0; batch < loads / 20; batch++)
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				fetch(`${origin}asset?i=${run}-${batch * 20 + i}`).then((response) =>
					response.arrayBuffer(),
				),
			),
		);
	return true;
};
/** in a page: how long a resource it loaded before takes again, and its status */
const again = async (url) => {
	const started = performance.now();
	const response = await fetch(url);
	await response.arrayBuffer();
	return {
		status: response.status,
		ms: Math.round(performance.now() - started),
	};
};

const browser = await launch();

// natively: the browser's cache hands the last one back at once
const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
await nativePage.evaluate(fill, {
	origin: ORIGIN,
	run: 'native',
	loads: LOADS,
});
const native = await nativePage.evaluate(
	again,
	`${ORIGIN}asset?i=native-${LOADS - 1}`,
);
await nativePage.close();
ok(
	'natively, a resource loaded last is loaded again at once',
	native.status === 200 && native.ms < 2000,
	JSON.stringify(native),
);

const workers = await workerMemory(browser);
const page = await openDemo(browser, PROXY);
await submitLanding(page, `${ORIGIN}page.html`);
let frame = null;
for (let i = 0; i < 120 && !frame; i++) {
	const found = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
	if (
		(await found?.evaluate(() => document.title).catch(() => null)) ===
		'CACHE WALKS'
	)
		frame = found;
	else await sleep(250);
}
ok('the proxied page loads', !!frame);
if (frame) {
	const filled = await frame
		.evaluate(fill, { origin: ORIGIN, run: 'proxied', loads: LOADS })
		.catch((error) => String(error).slice(0, 200));
	const requests = await workers.count('sw', 'Request');
	ok(
		'right after 120 MB of cacheable loads the worker holds about one walk of the store, not one per load',
		filled === true && requests < 5000,
		JSON.stringify({ filled, requests }),
	);
	const proxied = await frame
		.evaluate(again, `${ORIGIN}asset?i=proxied-${LOADS - 1}`)
		.catch((error) => ({ error: String(error).slice(0, 200) }));
	ok(
		'a resource it kept is loaded again at once, as natively, not after the walks',
		proxied.status === 200 && proxied.ms < 2000,
		JSON.stringify({ native, proxied }),
	);
}

await workers.detach();
server.close();
server.closeAllConnections();
await done(browser);
