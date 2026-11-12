// What a document pays for WebRTC before it uses it (docs/webrtc-over-wisp.md
// section 15): the inject carries the classes' shapes, and the code behind
// them (dist/rtcStack.js), the worker and the stack's module are fetched
// the first time the page makes a connection, once. A page that reads the
// classes, or wraps a prototype's member before its first connection as
// webrtc-adapter does, sees what it sees natively, and reads nothing of the
// library's request (no deprecation report, no resource entry).
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

const target = `${FIXTURE}pages/webrtc-lazy.html`;
const LIBRARY = /\/(rtcStack\.js|rtcWorker\.js|rtc\.wasm)(\?|$)/;
const RESOLVER =
	'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE *.local';
const browser = await launch([RESOLVER]);

const native = await (await browser.newContext()).newPage();
await native.goto(target);
await native.waitForFunction(() => window.__lazyReady);
const shapes = await native.evaluate(() => window.__lazy.shape());
const natively = await native.evaluate(() => window.__lazy.adaptAndConnect());
ok(
	'natively: a member wrapped before the first connection is the one that runs, and the call works',
	natively.message === 'first use' && natively.used.length === 2,
	JSON.stringify(natively),
);

for (const [label, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const asked = [];
	page.context().on('request', (request) => {
		if (LIBRARY.test(request.url())) asked.push(request.url());
	});
	await submitLanding(page, target);
	const frame = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		if (
			await frame()
				?.evaluate(() => window.__lazyReady)
				.catch(() => false)
		)
			break;
	}
	const shape = await frame().evaluate(() => window.__lazy.shape());
	ok(
		`${label}: the classes' prototypes read as the browser's before any is used`,
		JSON.stringify(shape) === JSON.stringify(shapes),
		JSON.stringify(shape).slice(0, 400),
	);
	await sleep(500);
	ok(
		`${label}: a document that has not used WebRTC has fetched none of it`,
		asked.length === 0,
		asked.join(' '),
	);
	const used = await frame().evaluate(() => window.__lazy.adaptAndConnect());
	ok(
		`${label}: its first connection loads it, and a member wrapped before that is the one that runs`,
		used.message === natively.message &&
			JSON.stringify(used.used) === JSON.stringify(natively.used),
		JSON.stringify(used),
	);
	ok(
		`${label}: the library, the worker and the stack's module are fetched once each`,
		['rtcStack.js', 'rtcWorker.js', 'rtc.wasm'].every(
			(name) => asked.filter((url) => url.includes(`/${name}`)).length === 1,
		),
		asked.join(' '),
	);
	ok(
		`${label}: the page reads no report and no resource entry of that`,
		JSON.stringify(used.reports) === JSON.stringify(natively.reports) &&
			JSON.stringify(used.entries) === JSON.stringify(natively.entries),
		JSON.stringify([used.reports, used.entries, natively.entries]),
	);
	await page.close();
}

await browser.close();
await done();
