// What the platform tells a page about itself names the page's URLs: an
// uncaught error's filename (window.onerror and the error event), the stack
// of code run through new Function (no inject frame, the page's call site as
// the eval origin), the Cache API's keys and matches (a string key resolves
// against the page and add() fetches through the proxy), and
// indexedDB.databases() lists the page's own databases by their own names.
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
await submitLanding(page, `${FIXTURE}pages/platform-readback.html`);
let pr = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		pr = (await frame.evaluate(() => window.__pr)) || {};
	} catch (error) {
		pr = {};
	}
	if (pr.done) break;
}
const leaks = (value) => /stomp\/|\$s\$/.test(JSON.stringify(value));
ok(
	'window.onerror and the error event name the real script',
	pr.onerror?.filename === `${FIXTURE}pages/boom.js` &&
		pr.event?.filename === `${FIXTURE}pages/boom.js` &&
		/boom/.test(pr.onerror?.message),
	JSON.stringify([pr.onerror, pr.event]),
);
ok(
	'a new Function stack names the page, not the inject bundle',
	typeof pr.stack === 'string' &&
		!leaks(pr.stack) &&
		pr.stack.includes(`${FIXTURE}pages/platform-readback.html`),
	JSON.stringify(pr.stack),
);
ok(
	'cache keys and matches are the page URLs, add() fetches through the proxy',
	JSON.stringify(pr.keys?.slice().sort()) ===
		JSON.stringify(
			[`${FIXTURE}pages/fresh.json`, `${FIXTURE}pages/echo.json`].sort(),
		) &&
		pr.matched === 'y' &&
		typeof pr.added === 'string' &&
		pr.added.length > 0 &&
		JSON.stringify(pr.cacheNames) === JSON.stringify(['pr-cache']),
	JSON.stringify([pr.keys, pr.matched, pr.added?.slice(0, 40), pr.cacheNames]),
);
ok(
	'indexedDB.databases() lists the page databases by their own names, deleteDatabase removes one',
	JSON.stringify(pr.databases) === JSON.stringify(['pr-db']) &&
		JSON.stringify(pr.afterDelete) === JSON.stringify([]),
	JSON.stringify([pr.databases, pr.afterDelete]),
);
ok(
	'eval code named by a sourceURL comment keeps the name in its stack',
	typeof pr.sourceURL === 'string' &&
		/named-by-comment\.js/.test(pr.sourceURL) &&
		!leaks(pr.sourceURL),
	JSON.stringify(pr.sourceURL),
);
ok('the fixture ran to completion', pr.done === true && !pr.error, pr.error);
await done(
	browser,
	page.errors.filter((e) => !/boom/.test(e)),
);
