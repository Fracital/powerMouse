// A WebSocket open when its document goes ends with the document, as
// natively: Chrome closes it (1001) when the page navigates away or its
// frame is removed, and the server sees the connection end. Proxied, the
// socket is the transport's (epoxy's, in the transport worker) on the
// other side of a port, and nothing ended it when the page's realm went
// (Chrome 157 fires no MessagePort close event): the upstream connection,
// its Wisp stream and the transport's port and buffers stayed for as long
// as the server kept it open, one more for every page of a long session
// that had a socket (chat, live updates, analytics). The document's
// transport closes its sockets on its pagehide (RemoteTransport.ts).
// Counted at the suite's own server, with the close codes it got, against
// the same pages loaded natively.
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

const COUNT = 3;
const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => sockets.once('listening', resolve));
/** tag -> [opened, open now] */
const seen = new Map();
/** tag -> the close codes the server got */
const codes = new Map();
sockets.on('connection', (ws, req) => {
	const tag = new URL(req.url, 'http://x/').searchParams.get('tag');
	const entry = seen.get(tag) ?? [0, 0];
	seen.set(tag, entry);
	entry[0]++;
	entry[1]++;
	ws.on('close', (code) => {
		entry[1]--;
		codes.set(tag, [...(codes.get(tag) ?? []), code].sort());
	});
});
const codesOf = (tag) => JSON.stringify(codes.get(tag) ?? []);
const port = sockets.address().port;
const page = (tag, extra) =>
	`${FIXTURE}pages/websocket-teardown.html?port=${port}&count=${COUNT}&tag=${tag}${extra}`;
const NEXT = encodeURIComponent(
	`${FIXTURE}pages/websocket-teardown.html?count=0&tag=next`,
);
const CASES = {
	'the page navigates away': (tag) => page(tag, `&go&next=${NEXT}`),
	'its frame is removed': (tag) => page(tag, '&frame'),
};

/** [opened, open] once COUNT opened and the document ended, 3 s after */
async function settle(tag) {
	for (let i = 0; i < 120 && (seen.get(tag)?.[0] ?? 0) < COUNT; i++)
		await sleep(250);
	// Chrome closes a navigated document's sockets as it unloads; give the
	// close a moment to reach the server
	for (let i = 0; i < 24 && (seen.get(tag)?.[1] ?? 0) > 0; i++)
		await sleep(250);
	return seen.get(tag) ?? [0, 0];
}

const browser = await launch();
const native = {};
for (const [name, url] of Object.entries(CASES)) {
	const tab = await browser.newPage();
	const tag = `native-${Object.keys(native).length}`;
	await tab.goto(url(tag));
	native[name] = await settle(tag);
	native[`${name} codes`] = codesOf(tag);
	await tab.close();
	ok(
		`natively, a socket left open as ${name} is closed: ${COUNT} opened, 0 open`,
		native[name][0] === COUNT && native[name][1] === 0,
		JSON.stringify(native[name]),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const tab = await openDemo(browser, base);
	let n = 0;
	for (const [name, url] of Object.entries(CASES)) {
		const tag = `${mode}-${n++}`;
		await submitLanding(tab, url(tag));
		const [opened, open] = await settle(tag);
		ok(
			`${mode}: a socket left open as ${name} is closed, as natively`,
			opened === COUNT && open === 0,
			`${opened} opened, ${open} still open (native ${JSON.stringify(native[name])})`,
		);
		ok(
			`${mode}: the server gets the close codes it gets natively as ${name}`,
			codesOf(tag) === native[`${name} codes`],
			`native ${native[`${name} codes`]} proxied ${codesOf(tag)}`,
		);
	}
	await tab.close();
}

sockets.close();
await done(browser);
