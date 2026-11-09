// A WebSocket handshake reaches the server as the browser's own does, read
// from the raw request the fixture received: an origin-form request-target
// (epoxy sent the whole `ws://host:port/path` URL, and Akamai, in front of
// TikTok's im-ws.tiktok.com, answers that with 400 "Invalid URL"), a Host
// that names the non-default port, one User-Agent (epoxy sent its own next
// to the page's), and every header line the native handshake carries, with
// its value, but Sec-WebSocket-Extensions: epoxy decodes no extension, so
// the proxy offers none. No line twice. Accept-Language, the user's
// languages, is the controller's to add (the transport cannot know them):
// its value is checked when it is there. Compared with the page loaded
// natively; both demo modes. The page's WebSocket.protocol is the one the
// server chose (epoxy reported "" for every socket).
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

const target = `${FIXTURE}pages/ws-handshake.html`;
// header values that are the same natively and proxied (the key is random)
const SAME = [
	'host',
	'connection',
	'pragma',
	'cache-control',
	'user-agent',
	'upgrade',
	'origin',
	'sec-websocket-version',
	'accept-encoding',
	'accept-language',
	'sec-websocket-protocol',
];

// not the transport's: checked only when present
const CONTROLLER = ['accept-language'];

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__hs).catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

/** the raw header lines as [lowercased name, value] pairs */
const lines = (record) => {
	const raw = record?.echo?.raw ?? [];
	const out = [];
	for (let i = 0; i < raw.length; i += 2)
		out.push([raw[i].toLowerCase(), raw[i + 1]]);
	return out;
};
const values = (record, name) =>
	lines(record)
		.filter(([n]) => n === name)
		.map(([, v]) => v);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
const fixtureHost = new URL(FIXTURE).host;
ok(
	'natively, the handshake is origin-form with the port in Host',
	native?.echo?.url === '/ws-echo?hs=1' &&
		values(native, 'host').join() === fixtureHost,
	JSON.stringify(native),
);
console.log(
	'  native order:',
	lines(native)
		.map(([n]) => n)
		.join(', '),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: the handshake reaches the server`,
		!!proxied?.echo && proxied.error === undefined,
		JSON.stringify(proxied),
	);
	ok(
		`${mode}: the request-target is origin-form, as natively`,
		proxied?.echo?.url === native?.echo?.url,
		JSON.stringify({ native: native?.echo?.url, proxied: proxied?.echo?.url }),
	);
	ok(
		`${mode}: the request is HTTP/1.1`,
		proxied?.echo?.version === '1.1',
		JSON.stringify(proxied?.echo?.version),
	);
	ok(
		`${mode}: Host names the non-default port`,
		values(proxied, 'host').join('|') === fixtureHost,
		JSON.stringify(values(proxied, 'host')),
	);
	ok(
		`${mode}: one User-Agent, the browser's`,
		values(proxied, 'user-agent').length === 1 &&
			values(proxied, 'user-agent')[0] === values(native, 'user-agent')[0],
		JSON.stringify(values(proxied, 'user-agent')),
	);
	const names = lines(proxied).map(([n]) => n);
	const repeated = names.filter((n, i) => names.indexOf(n) !== i);
	ok(
		`${mode}: no header line twice`,
		repeated.length === 0,
		JSON.stringify(repeated),
	);
	const expected = lines(native)
		.map(([n]) => n)
		.filter((n) => n !== 'sec-websocket-extensions');
	const missing = expected.filter(
		(n) => !names.includes(n) && !CONTROLLER.includes(n),
	);
	ok(
		`${mode}: every header the native handshake carries is there`,
		missing.length === 0,
		JSON.stringify({ missing, proxied: names }),
	);
	const extra = names.filter(
		(n) => !lines(native).some(([name]) => name === n),
	);
	ok(
		`${mode}: no header the native handshake lacks`,
		extra.length === 0,
		JSON.stringify(extra),
	);
	const differ = SAME.filter(
		(n) =>
			values(native, n).length &&
			(values(proxied, n).length || !CONTROLLER.includes(n)) &&
			values(proxied, n).join('|').toLowerCase() !==
				values(native, n).join('|').toLowerCase(),
	);
	ok(
		`${mode}: the values are the native ones`,
		differ.length === 0,
		JSON.stringify(
			Object.fromEntries(
				differ.map((n) => [
					n,
					{ native: values(native, n), proxied: values(proxied, n) },
				]),
			),
		),
	);
	ok(
		`${mode}: no extension offered (epoxy decodes none)`,
		values(proxied, 'sec-websocket-extensions').length === 0,
		JSON.stringify(values(proxied, 'sec-websocket-extensions')),
	);
	ok(
		`${mode}: WebSocket.protocol is the one the server chose`,
		!!native?.protocol && proxied?.protocol === native.protocol,
		JSON.stringify({ native: native?.protocol, proxied: proxied?.protocol }),
	);
	console.log(`  ${mode} order:`, names.join(', '));
	for (const n of CONTROLLER)
		if (!values(proxied, n).length)
			console.log(`  ${mode}: no ${n} (the controller adds none yet)`);
	await page.close();
}
await done(browser);
