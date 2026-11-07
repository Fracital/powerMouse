// Workers that are not a plain `new Worker(url)`: a worker from a blob: URL
// (the service worker cannot read it, so the page rewrites it), a module
// worker (no importScripts there), a SharedWorker, and a paint worklet.
// Each must start and reach the proxy.
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

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
