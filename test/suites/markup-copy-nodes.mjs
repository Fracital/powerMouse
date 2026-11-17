// What a proxied document's markup costs in DOM nodes. The inject parses
// the page's markup (DOMParser), copies it into an inert document through
// the hooks, which route its URLs, and writes the copy's serialization,
// which the browser parses into the page: three trees of the markup, where
// natively there is one. The copy read each parsed element's attributes
// through its `attributes` map, and Blink made the map and an Attr node for
// every attribute the moment it was read, all of it garbage once the copy
// was made: on an ad frame of 150 links (a class on each of their 150
// rows) that was 300 nodes more per frame, left to the renderer's
// collector in same-origin mode, where every frame shares the renderer. The copy reads them by name now. Blink's count of
// the nodes it made and has not swept (Memory.getDOMCounters) across the
// load of one such frame, after a full collection: the three trees and
// nothing more (3049 nodes against 914 natively before, 2749 now), five
// frames one after another. Same-origin mode, where the frames are the
// host's renderer's.
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

const LINKS = 150;
const FRAMES = 5;

let rows = '';
for (let i = 0; i < LINKS; i++)
	rows += `<div class="c${i % 9}"><span>row ${i}</span><a href="/frame.html?x=${i}">link ${i}</a></div>\n`;
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	res.writeHead(
		url.pathname === '/top.html' || url.pathname === '/frame.html' ? 200 : 404,
		{
			'content-type': 'text/html; charset=utf-8',
		},
	);
	if (url.pathname === '/top.html')
		res.end(
			'<!doctype html><title>COPY NODES</title><script>window.__ranAt = performance.now();</script>',
		);
	else if (url.pathname === '/frame.html')
		res.end(
			`<!doctype html><html><head><title>frame</title></head><body>${rows}<script>window.__ranAt = performance.now();</script></body></html>`,
		);
	else res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch();

/** the nodes made and not swept across the load of each of FRAMES frames of `top`, one by one */
async function nodesPerFrame(tab, top) {
	const out = [];
	for (let n = 1; n <= FRAMES; n++) {
		const cdp = await tab.context().newCDPSession(tab);
		await cdp.send('HeapProfiler.enable');
		for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
		const before = await cdp.send('Memory.getDOMCounters');
		await top.evaluate((src) => {
			const child = document.createElement('iframe');
			child.src = src;
			document.body.append(child);
		}, `${ORIGIN}frame.html?n=${n}`);
		let ran = 0;
		for (let i = 0; i < 200 && ran < n; i++) {
			await sleep(100);
			const kids = tab.frames().filter((f) => f.parentFrame() === top);
			ran = (
				await Promise.all(
					kids.map((kid) =>
						kid
							.evaluate(() => typeof window.__ranAt === 'number')
							.catch(() => false),
					),
				)
			).filter(Boolean).length;
		}
		const after = await cdp.send('Memory.getDOMCounters');
		await cdp.detach();
		out.push(ran >= n ? after.nodes - before.nodes : null);
	}
	return out;
}

const nativeTab = await browser.newPage();
await nativeTab.goto(`${ORIGIN}top.html`);
const native = await nodesPerFrame(nativeTab, nativeTab.mainFrame());
await nativeTab.close();
const perFrame = native[native.length - 1];
ok(
	'natively, every frame makes its markup and the same nodes',
	native.every((nodes) => nodes !== null && nodes === perFrame) &&
		perFrame > LINKS * 5,
	JSON.stringify(native),
);

const tab = await openDemo(browser, PROXY);
const known = new Set(tab.frames());
await submitLanding(tab, `${ORIGIN}top.html`);
let top = null;
for (let i = 0; i < 120 && !top; i++) {
	await sleep(250);
	const frame = tab
		.frames()
		.findLast(
			(f) => !known.has(f) && /\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);
	if (
		await frame
			?.evaluate(() => document.title === 'COPY NODES')
			.catch(() => false)
	)
		top = frame;
}
ok('the proxied page loads', !!top);
if (top) {
	const proxied = await nodesPerFrame(tab, top);
	ok(
		'a proxied frame makes the three trees of its markup and no Attr node',
		proxied.every(
			(nodes) => nodes !== null && nodes <= perFrame * 3 + LINKS / 10,
		),
		JSON.stringify({ native: perFrame, proxied }),
	);
}

server.close();
server.closeAllConnections();
await done(browser, tab.errors);
