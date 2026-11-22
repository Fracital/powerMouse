// Chromium 159's WebTransportOptions gains two enums, with observable
// getter order. Its datagrams use a default stream unless explicitly asked
// for bytes. Compare the page's real browser API to the injected stand-in,
// in both proxy modes, without needing a working QUIC server.
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const url = `${FIXTURE}pages/blank-cors.html`;
const native = await browser.newPage();
await native.goto(url);

const examine = () => {
	const endpoint = 'https://127.0.0.1:1/';
	const order = [];
	const outcomes = {};
	const errors = {};
	const traced = new Proxy(
		{},
		{
			get(_target, key) {
				order.push(String(key));
				return undefined;
			},
		},
	);
	const instance = (options) => {
		const session = new WebTransport(endpoint, options);
		session.ready.catch(() => {});
		session.closed.catch(() => {});
		return session;
	};
	for (const [name, options] of [
		['default', undefined],
		['bytes', { datagramsReadableType: 'bytes' }],
		['congestion', { congestionControl: 'low-latency' }],
		['badCongestion', { congestionControl: 'bogus' }],
		['badReadable', { datagramsReadableType: 'bogus' }],
	]) {
		try {
			const session = instance(options);
			const read = session.datagrams.readable;
			let byob;
			try {
				const reader = read.getReader({ mode: 'byob' });
				byob = 'supported';
				reader.releaseLock();
			} catch (error) {
				byob = `${error.name}: ${error.message}`;
			}
			outcomes[name] = { byob };
			session.close();
		} catch (error) {
			errors[name] = `${error.name}: ${error.message}`;
		}
	}
	const noOptions = instance(traced);
	noOptions.close();
	const streamGetterReads = [];
	const query = new Proxy(
		{},
		{
			get(_target, key) {
				streamGetterReads.push(String(key));
				return undefined;
			},
		},
	);
	const s = instance();
	s.createBidirectionalStream(query).catch(() => {});
	s.createUnidirectionalStream(query).catch(() => {});
	s.close();
	return { outcomes, errors, order, streamGetterReads };
};

const expected = await native.evaluate(examine);
// CI's Chrome comes from the runner image. A runner still on 158 has no
// datagramsReadableType dictionary member and the older byte-stream default;
// the general WebTransport suite covers that version. Only require 159's
// changes after observing them on the native control page.
if (!expected.order.includes('datagramsReadableType')) {
	console.log(
		'SKIP Chromium 159 WebTransport options: native browser is older',
	);
	await native.close();
	await done(browser);
}
ok(
	'Chromium control: default datagrams are not byte streams, explicit bytes are',
	expected.outcomes.bytes?.byob === 'supported' &&
		expected.outcomes.default?.byob.includes('non-byte stream'),
	JSON.stringify(expected.outcomes),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, url);
	const frame = await (async () => {
		await page.waitForFunction(
			() => !document.getElementById('browser').classList.contains('hidden'),
		);
		for (let i = 0; i < 120; i++) {
			const found = await activeFrame(page);
			if (
				found &&
				(await found
					.evaluate(() => !!globalThis.WebTransport)
					.catch(() => false))
			)
				return found;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`no proxied frame in ${mode}`);
	})();
	const actual = await frame.evaluate(examine);
	ok(
		`${mode}: default vs explicit byte datagrams match Chromium 159`,
		JSON.stringify(actual.outcomes) === JSON.stringify(expected.outcomes),
		JSON.stringify(actual.outcomes),
	);
	ok(
		`${mode}: accepted and invalid enum values match Chromium 159`,
		JSON.stringify(actual.errors) === JSON.stringify(expected.errors),
		JSON.stringify(actual.errors),
	);
	ok(
		`${mode}: constructor option getters run in native order`,
		JSON.stringify(actual.order) === JSON.stringify(expected.order),
		JSON.stringify({ native: expected.order, proxied: actual.order }),
	);
	ok(
		`${mode}: stream-creation option getters run in native order`,
		JSON.stringify(actual.streamGetterReads) ===
			JSON.stringify(expected.streamGetterReads),
		JSON.stringify({
			native: expected.streamGetterReads,
			proxied: actual.streamGetterReads,
		}),
	);
	await page.close();
}

await native.close();
await done(browser);
