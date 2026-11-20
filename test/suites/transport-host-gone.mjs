// A proxied document whose transport another tab serves (the host's tab,
// or its transport worker) when that tab goes. The document's WebSockets
// ride a RemoteTransport whose port the host serves; once the host's tab
// closes nothing answers there, and Chrome 157 fires no MessagePort close
// event, so the RemoteTransport never heard it: an open socket stayed OPEN
// with no transport behind it, and a new one stayed CONNECTING for good.
// The serving side says it goes (serveTransport on its realm's pagehide,
// the transport worker when the controller's page goes), and the page's
// sockets end as when the network drops (close 1006), a new one fails at
// once. A tab of its own on the routed URL, as a link opened from a
// proxied page in a new tab is. The host page is transport-host.html, as
// in transport-worker: `descriptor` hosts the transport in the worker,
// `page` in the host's page.
import { WebSocketServer } from 'ws';
import { done, FIXTURE, launch, ok, PORT, sleep } from '../lib.mjs';

const WISP = `ws://127.0.0.1:${PORT}/wisp/`;
const ORIGIN = new URL(FIXTURE).origin.replace('127.0.0.1', 'localhost');
const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => sockets.once('listening', resolve));
const port = sockets.address().port;

const browser = await launch();
const errors = [];

/** the events of `tag`'s socket in `page` once `until` holds of them, or after `ms` */
async function eventsOf(page, tag, until, ms = 8000) {
	let events = [];
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
		events = await page
			.evaluate((t) => window.__tg?.sockets[t] ?? [], tag)
			.catch(() => []);
		if (until(events)) break;
	}
	return events.map(([type, code]) =>
		code === null ? type : `${type} ${code}`,
	);
}
const closed = (events) => events.some(([type]) => type === 'close');

for (const mode of ['descriptor', 'page']) {
	const context = await browser.newContext();
	const host = await context.newPage();
	host.on('pageerror', (error) => errors.push(error.message));
	const query = new URLSearchParams({ wisp: WISP, transport: mode });
	await host.goto(`${FIXTURE}pages/transport-host.html?${query}`);
	await host
		.waitForFunction(() => window.__th?.ready, null, { timeout: 60000 })
		.catch(() => {});
	const record = await host.evaluate(() => window.__th);
	ok(
		`${mode}: the host boots`,
		record.ready &&
			!record.error &&
			record.host === (mode === 'page' ? 'page' : 'worker'),
		JSON.stringify(record),
	);
	const routed = await host.evaluate(
		(url) => window.controller.route(url),
		`${ORIGIN}/pages/transport-gone.html?port=${port}`,
	);
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(routed);
	await page
		.waitForFunction(() => window.__tg?.ready, null, { timeout: 30000 })
		.catch(() => {});
	await page.evaluate(() => window.openSocket('before')).catch(() => {});
	const before = await eventsOf(page, 'before', (events) => events.length > 0);
	ok(
		`${mode}: a socket of the page in a tab of its own opens over the host's transport`,
		before.join() === 'open',
		before.join(),
	);

	// the tab that serves the transport goes
	await host.close();
	const ended = await eventsOf(page, 'before', closed);
	ok(
		`${mode}: once the host's tab closed the page's open socket ends as a dropped connection (1006)`,
		ended.join() === 'open,close 1006',
		ended.join() || 'no event',
	);
	await page.evaluate(() => window.openSocket('after')).catch(() => {});
	const after = await eventsOf(page, 'after', closed);
	ok(
		`${mode}: and a new one fails at once (error, close 1006) instead of staying CONNECTING`,
		after.join() === 'error,close 1006',
		after.join() || 'no event',
	);
	await context.close();
}

sockets.close();
await done(browser, errors);
