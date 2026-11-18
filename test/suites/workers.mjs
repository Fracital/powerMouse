// Workers that are not a plain `new Worker(url)`: a worker from a blob: URL
// (the service worker cannot read it, so the page rewrites it), a module
// worker (no importScripts there), a SharedWorker, a paint worklet and an
// audio worklet. Each must start and reach the proxy; what the audio
// worklet's processor reports is compared with the page loaded natively.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();

// the page loaded natively, for what its audio worklet reports
const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
await nativePage.goto(`${FIXTURE}pages/workers.html`);
await nativePage.waitForFunction(() => window.__wk?.done, null, {
	timeout: 30000,
});
const natively = await nativePage.evaluate(() => window.__wk);
await nativeContext.close();

const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}pages/workers.html`);

let wk = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		wk = (await frame.evaluate(() => window.__wk)) || {};
	} catch (error) {
		wk = {};
	}
	if (wk.done) break;
}
ok(
	'a blob: URL worker starts and fetches through the proxy',
	wk.blob === true,
	JSON.stringify(wk.blob),
);
ok(
	'a module worker starts and fetches through the proxy',
	wk.module === true,
	JSON.stringify(wk.module),
);
ok(
	'a SharedWorker starts and fetches through the proxy',
	wk.shared === true,
	JSON.stringify(wk.shared),
);
ok(
	'a paint worklet module loads',
	wk.worklet === true,
	JSON.stringify(wk.worklet),
);

ok(
	"an audio worklet's module runs as natively (its imports, an import cycle, computed members, its port, its errors)",
	typeof natively.audio === 'object' &&
		JSON.stringify(wk.audio) === JSON.stringify(natively.audio),
	`native ${JSON.stringify(natively.audio)} proxied ${JSON.stringify(wk.audio)}`,
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
