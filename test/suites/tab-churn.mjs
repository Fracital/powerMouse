// A tab the user closes leaves nothing of its page in the pages that stay.
// Natively a closed tab's documents go with it. Through the proxy every tab
// is a frame of the host page, in its renderer, and the controller's joint
// session history (src/controller/history.ts) kept each tab's history in a
// Set of its own, with its window, and the window its last document's whole
// realm: about 2 MB of the host's heap for every tab ever closed, the page
// and the inject, and a real site's page is tens of megabytes. Measured as
// the host page's JS heap after a GC per tab opened through the demo's
// landing form and closed with the recents view's close button, after WARM
// tabs, against a native page that opens and closes as many tabs of the same
// page.
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
const WARM = 3;
const TABS = 8;
const page = (i) =>
	`${FIXTURE}pages/memory-churn-child.html?raf&img&fn&tab=${i}`;

async function heapAfterGC(cdp) {
	for (let i = 0; i < 3; i++) {
		await cdp.send('HeapProfiler.collectGarbage');
		await sleep(200);
	}
	return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1024;
}

/** KB per tab the page `stays` keeps when `cycle(i)` opens and closes one */
async function perTab(stays, cycle) {
	const cdp = await stays.context().newCDPSession(stays);
	await cdp.send('HeapProfiler.enable');
	for (let i = 0; i < WARM; i++) await cycle(i);
	await sleep(300);
	const before = await heapAfterGC(cdp);
	for (let i = WARM; i < WARM + TABS; i++) await cycle(i);
	await sleep(300);
	const after = await heapAfterGC(cdp);
	await cdp.detach();
	return (after - before) / TABS;
}

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${FIXTURE}landed?tab-churn`);
const native = await perTab(nativePage, async (i) => {
	const tab = await browser.newPage();
	await tab.goto(page(i));
	await tab.waitForFunction(() => typeof window.__ranAt === 'number');
	await tab.close();
});
await nativePage.close();

const host = await openDemo(browser, PROXY);
let failed = null;
const proxied = await perTab(host, async (i) => {
	if (failed) return;
	const before = new Set(host.frames());
	await submitLanding(host, page(i));
	let frame;
	for (let k = 0; k < 120 && !frame; k++) {
		await sleep(250);
		frame = host
			.frames()
			.find(
				(f) =>
					!before.has(f) &&
					f.parentFrame() === host.mainFrame() &&
					ROUTE.test(f.url()),
			);
	}
	try {
		await frame.waitForFunction(
			() => typeof window.__ranAt === 'number',
			null,
			{
				timeout: 30000,
			},
		);
		await host.click('#recents');
		await sleep(300);
		await host.click('.close');
		await host.waitForFunction(
			() => !document.getElementById('landing').classList.contains('hidden'),
			null,
			{ timeout: 10000 },
		);
	} catch (error) {
		failed = error.message.slice(0, 200);
	}
});

ok('the demo opens and closes each tab', !failed, failed ?? '');
// a kept tab is its page's realm and the inject's, about 2 MB here; what
// the host's own bookkeeping keeps of a closed tab is a few dozen KB
ok(
	'a closed tab leaves nothing of its page',
	proxied - native < 500,
	`proxied ${proxied.toFixed(1)} KB native ${native.toFixed(1)} KB per tab`,
);

await done(browser);
