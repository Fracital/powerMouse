// A frame the page removes, or navigates to another document, leaves
// nothing of its document behind. Every proxied site is the proxy's one
// real origin, so each proxied frame is a realm in the page's own renderer
// (about 1 MB with the inject, frame-cost): a realm kept after its frame
// went is a megabyte for every ad the page rotates or frame it replaces,
// and the renderer ran out of memory on ad-heavy sites. Measured as the
// page's JS heap after a GC, over CYCLES cycles once WARM ran, per cycle,
// against the same page loaded natively, for each way a page's frames come
// and go (CASES).
//
// WebRTC's tables (shared by a frame and its parent) kept every frame's
// realm: each document's entry was a WeakRef made by its own realm, and an
// object keeps the realm that made it.
//
// A frame of another site than the top kept its realm through the
// observers it keeps on its frame elements (AnimationFrames): Blink keeps an
// observer rooted at another document until it is disconnected.
//
// An about:blank frame runs its creator's bundle, whose table of the Blobs
// behind minted blob: URLs kept the frame's Blobs, and with them its realm.
//
// A frame navigated from site to site is given a fresh browsing context
// each time, and the registry of the windows it showed before kept them all
// (freshContext).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const ROUTE = /\/stomp\/[\w-]+\/html\//;
const SAME = FIXTURE;
const CROSS = FIXTURE.replace('127.0.0.1', 'localhost');
const CHILD = 'pages/memory-churn-child.html';
const WARM = 6;
const CYCLES = 15;

// each runs in the page's document and resolves once the cycle is over
const CASES = {
	'a frame of the site, added and removed': (i, same, cross, child) =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			frame.src = `${same}${child}?raf&img&i=${i}`;
			frame.onload = () => setTimeout(() => (frame.remove(), resolve()), 50);
			document.body.append(frame);
		}),
	'a frame navigated to another document': (i, same, cross, child) =>
		new Promise((resolve) => {
			let frame = document.getElementById('navigated');
			if (!frame) {
				frame = document.createElement('iframe');
				frame.id = 'navigated';
				document.body.append(frame);
			}
			frame.onload = () => setTimeout(resolve, 50);
			frame.src = `${same}${child}?img&n=${i}`;
		}),
	'a frame navigated from one site to another': (i, same, cross, child) =>
		new Promise((resolve) => {
			let frame = document.getElementById('crossing');
			if (!frame) {
				frame = document.createElement('iframe');
				frame.id = 'crossing';
				document.body.append(frame);
			}
			frame.onload = () => setTimeout(resolve, 50);
			frame.src = `${i % 2 ? cross : same}${child}?img&n=${i}`;
		}),
	'a frame of another site, added and removed': (i, same, cross, child) =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			frame.src = `${cross}${child}?raf&blob&img&fn&i=${i}`;
			frame.onload = () => setTimeout(() => (frame.remove(), resolve()), 50);
			document.body.append(frame);
		}),
	'an about:blank frame, written and removed': (i) =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			document.body.append(frame);
			const doc = frame.contentDocument;
			doc.open();
			// blob: URLs it never revokes, which go with it natively
			doc.write(
				`<p>${i}</p><script>for (let k = 0; k < 3; k++) window['u' + k] = URL.createObjectURL(new Blob(['${i}']))</script>`,
			);
			doc.close();
			setTimeout(() => (frame.remove(), resolve()), 50);
		}),
};

async function heapAfterGC(cdp) {
	for (let i = 0; i < 3; i++) {
		await cdp.send('HeapProfiler.collectGarbage');
		await sleep(200);
	}
	return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1024;
}

/** KB per cycle the page's heap keeps, per case, `site()` the page's document */
async function measure(tab, site) {
	const cdp = await tab.context().newCDPSession(tab);
	await cdp.send('HeapProfiler.enable');
	const result = {};
	for (const [name, run] of Object.entries(CASES)) {
		const cycles = async (from, count) => {
			for (let i = from; i < from + count; i++)
				await site().evaluate(
					([source, i, same, cross, child]) =>
						(0, eval)(`(${source})`)(i, same, cross, child),
					[run.toString(), i, SAME, CROSS, CHILD],
				);
		};
		try {
			await cycles(0, WARM);
			await sleep(300);
			const before = await heapAfterGC(cdp);
			await cycles(WARM, CYCLES);
			await sleep(300);
			result[name] = ((await heapAfterGC(cdp)) - before) / CYCLES;
		} catch (error) {
			result[name] = `failed: ${error.message.slice(0, 160)}`;
		}
	}
	await cdp.detach();
	return result;
}

const browser = await launch();

const nativeTab = await browser.newPage();
await nativeTab.goto(`${FIXTURE}landed?frame-churn`);
const native = await measure(nativeTab, () => nativeTab.mainFrame());
await nativeTab.close();

const tab = await openDemo(browser, PROXY);
await submitLanding(tab, `${FIXTURE}landed?frame-churn`);
// the tab's frame, not one of the frames the cases add to it
const site = () =>
	tab
		.frames()
		.find((f) => f.parentFrame() === tab.mainFrame() && ROUTE.test(f.url()));
for (let i = 0; i < 120 && !site(); i++) await sleep(250);
await site().waitForFunction(() => document.title === 'LANDED', null, {
	timeout: 30000,
});
const proxied = await measure(tab, site);

const kb = (value) =>
	typeof value === 'number' ? `${value.toFixed(1)} KB` : value;
// a kept realm is 700 KB to 1.1 MB a cycle (frame-cost); what a cycle may
// leave while the proxy's own bounded tables and caches fill is under 70 KB
// for the first few dozen cycles, then about 2 KB
for (const name of Object.keys(CASES))
	ok(
		`${name}: nothing of the frame is kept`,
		typeof native[name] === 'number' &&
			typeof proxied[name] === 'number' &&
			proxied[name] - native[name] < 300,
		`proxied ${kb(proxied[name])} native ${kb(native[name])} per cycle`,
	);

await done(browser);
