// A document.cookie write read back at once (an ad library's probe, then
// its ids) shows what the browser shows: in the writing document, in a new
// frame's about:blank document and in a same-origin sibling frame, each
// what the writer reads natively. The writing document's own reads after
// its writes cost no round trip of their own: the jar answers a write with
// the document's cookies after it. An ad page wrote over a hundred cookies
// a load, each read again at once, and every read was a synchronous round
// trip that held the page's thread. Compared with the page loaded
// natively; both demo modes.
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

const target = `${FIXTURE}pages/cookie-write-reads.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__cwr).catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
// natively nothing counts round trips
await nativePage.evaluate(() => {
	window.__reads = () => 0;
});
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the page ran to the end',
	native?.done && !native.error && native.steps.length === 12,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const name = await page.evaluate(() => window.controller.config.names.client);
	await submitLanding(page, target);
	// the page counts its client's reads of the jar through this reader: no
	// page can reach its client (by the name the controller minted)
	let shown = null;
	for (let i = 0; i < 80 && !shown; i++) {
		await sleep(250);
		shown = page
			.frames()
			.find(
				(frame) =>
					frame.parentFrame() === page.mainFrame() &&
					/\/stomp\/[\w-]+\/html\//.test(frame.url()),
			);
	}
	await shown
		?.evaluate((name) => {
			window.__reads = () => window[name].cookieReads;
		}, name)
		.catch(() => {});
	const proxied = await report(page);
	ok(
		`${mode}: the page ran to the end`,
		proxied?.done && !proxied.error,
		JSON.stringify(proxied),
	);
	// What the writer reads natively is the jar after the write. Another
	// document's read right after it is a race natively (Chrome may show it
	// the jar of a moment before), so every document is held to the
	// writer's: a frame reads the writes of the frames beside it at once
	for (const [index, [step, writer, ...seen]] of (
		native?.steps ?? []
	).entries()) {
		const got = proxied?.steps?.[index]?.slice(2);
		ok(
			`${mode}: ${step}: every document reads what the writer reads natively`,
			JSON.stringify(got) === JSON.stringify([0, 1, 2].map(() => seen[writer])),
			JSON.stringify({ native: seen, writer, proxied: got }),
		);
	}
	// what it read before the first write, once; every read after one of its
	// own writes comes with the write's answer
	ok(
		`${mode}: the writing document's reads after its own writes cost no round trip`,
		proxied !== null && proxied.ownReads <= 3,
		JSON.stringify(proxied?.ownReads),
	);
	await page.close();
}

await done(browser);
