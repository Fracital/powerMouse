// A worker believes it runs where the page put it: self.location (href,
// origin, pathname, String()) and self.origin are the real script URL for a
// classic or module worker, the same blob under the page's origin for a blob:
// worker, and a shared worker reads its own name back (the constructor hook
// appends the origin to keep proxied origins apart). Stacks agree.
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
await submitLanding(page, `${FIXTURE}pages/worker-location.html`);
let wl = {};
for (let i = 0; i < 80; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		wl = (await frame.evaluate(() => window.__wl)) || {};
	} catch (error) {
		wl = {};
	}
	if (wl.done) break;
}
const origin = new URL(FIXTURE).origin;
const script = `${FIXTURE}pages/worker-loc.js`;
const leaks = (value) => /stomp\/|\$s\$/.test(JSON.stringify(value));
for (const kind of ['classic', 'module']) {
	const w = wl[kind] || {};
	ok(
		`a ${kind} worker sees its real URL and origin`,
		w.href === script &&
			w.string === script &&
			w.origin === origin &&
			w.locationOrigin === origin &&
			w.pathname === '/pages/worker-loc.js' &&
			!leaks(w),
		JSON.stringify(w),
	);
}
ok(
	'a classic worker keeps its name',
	wl.classic?.name === 'wl-classic',
	JSON.stringify(wl.classic?.name),
);
ok(
	'a blob: worker sees its blob under the page origin, in its stack too',
	typeof wl.blob?.href === 'string' &&
		wl.blob.href.startsWith(`blob:${origin}/`) &&
		wl.blob.origin === origin &&
		wl.blob.locationOrigin === origin &&
		wl.blob.name === 'wl-blob' &&
		wl.blob.stack.includes(`blob:${origin}/`) &&
		!leaks(wl.blob),
	JSON.stringify(wl.blob),
);
ok(
	'a shared worker reads its own name and URL back',
	wl.shared?.name === 'wl-shared' &&
		wl.shared?.href === `${FIXTURE}pages/worker-loc-shared.js` &&
		wl.shared?.origin === origin,
	JSON.stringify(wl.shared),
);
ok('the fixture ran to completion', wl.done === true && !wl.error, wl.error);
await done(browser, page.errors);
