// A proxied WebSocket ends as a native one does, event by event: a
// connection that fails fires error and then close with 1006 (the
// transport reported the error only, and the page waited for a close that
// never came), the page's close() without a code reads 1005 (it read
// 1000), and the page's own code and reason come back (epoxy never
// answered a close with either, and the page waited for good), with
// readyState CLOSED in the close event. A close the server starts reads
// the server's code and reason: epoxy reported every one as 1000 "Closed
// by remote" (it never read the frame), so a page saw 1000 for 4000 "srv",
// 1001 and a connection that ended without a close frame alike (fixed by
// deploy/epoxy/patches, which pass the frame's status and reason on).
// Compared with the page loaded natively, in both modes, against a server
// of the suite's own.
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => sockets.once('listening', resolve));
sockets.on('connection', (ws, req) => {
	const path = new URL(req.url, 'http://x/').pathname;
	const later = (fn) => setTimeout(fn, 50);
	if (path === '/quiet') later(() => ws.close());
	else if (path === '/code') later(() => ws.close(4000, 'srv'));
	else if (path === '/normal') later(() => ws.close(1000, 'done'));
	else if (path === '/away') later(() => ws.close(1001));
	else if (path === '/utf8') later(() => ws.close(4001, 'adi\u00f3s \u2713'));
	// the longest reason a close frame carries (125 bytes less the code)
	else if (path === '/long') later(() => ws.close(4002, 'r'.repeat(123)));
	// the connection ends with no close frame
	else if (path === '/drop') later(() => ws.terminate());
	// /hold: open until the page closes it (ws echoes the page's close)
});
// a port nothing listens on: taken, then let go
const refused = await new Promise((resolve) => {
	const server = createServer().listen(0, '127.0.0.1', () => {
		const { port } = server.address();
		server.close(() => resolve(port));
	});
});
const PAGE = `${FIXTURE}pages/websocket-close.html?port=${sockets.address().port}&refused=${refused}`;

async function measure(frames) {
	for (let i = 0; i < 160; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(() => window.__wsClose ?? null)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	"natively: a refused connection closes with 1006, a close without a status reads 1005, the server's code and reason come through",
	!!native?.refused?.includes('close 1006') &&
		!!native?.serverNoStatus?.includes('close 1005') &&
		!!native?.serverCode?.includes('close 4000 srv true'),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() =>
		page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	for (const name of [
		'refused',
		'serverNoStatus',
		'serverCode',
		'serverNormal',
		'serverAway',
		'serverUtf8',
		'serverLong',
		'serverDrop',
		'pageNoCode',
		'pageCode',
	])
		ok(
			`${mode}: ${name} ends as natively`,
			proxied?.[name] === native[name],
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied?.[name])}`,
		);
	await page.close();
}

sockets.close();
await done(browser);
