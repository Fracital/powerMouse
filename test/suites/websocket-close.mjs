// A proxied WebSocket ends as a native one does, event by event: a
// connection that fails fires error and then close with 1006 (the
// transport reported the error only, and the page waited for a close that
// never came), the page's close() without a code reads 1005 (it read
// 1000), and the page's own code and reason come back (epoxy never
// answered a close with either, and the page waited for good), with
// readyState CLOSED in the close event. Compared with the page loaded
// natively, in both modes, against a server of the suite's own.
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
	if (path === '/quiet') setTimeout(() => ws.close(), 50);
	else if (path === '/code') setTimeout(() => ws.close(4000, 'srv'), 50);
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
	'natively: a refused connection closes with 1006, a close without a status reads 1005',
	!!native?.refused?.includes('close 1006') &&
		!!native?.serverNoStatus?.includes('close 1005'),
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
	// a close the server starts is the transport's to read: epoxy reports
	// every one as 1000 (it never reads the frame), shown, not compared
	console.log(
		`${mode}: the server's own close, natively ${native?.serverCode} and ${native?.serverNoStatus}, through epoxy ${proxied?.serverCode} and ${proxied?.serverNoStatus}`,
	);
	for (const name of ['refused', 'pageNoCode', 'pageCode'])
		ok(
			`${mode}: ${name} ends as natively`,
			proxied?.[name] === native[name],
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied?.[name])}`,
		);
	await page.close();
}

sockets.close();
await done(browser);
