// The "Block scripts" per-site shield (the demo's content blocker, after Brave
// Shields): with it on for a site, the inject enforces script-src 'none'
// against the page's own code (src/csp.ts stage 2) so none of the page's
// scripts run, inline or external, while STomp's own inject still renders and
// rewrites the page. It is inject-side page-code enforcement, never a browser
// CSP header (that would kill STomp's shell), and it is off by default
// (destructive). Off again, the page's scripts run as they always did.
//
// The suite reads the page's state through the debugger (frame.evaluate), not a
// page script, since a page script is exactly what the shield blocks. Shields
// are set on the demo's own controller and reach the worker over its `shields`
// RPC; same-origin mode.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const host = new URL(FIXTURE).hostname;
const target = `${FIXTURE}pages/shields-scripts.html`;
const report = (frame) =>
	frame.evaluate(() => ({
		inlineRan: !!window.__inlineRan,
		extRan: !!window.__extRan,
		marker: document.getElementById('marker')?.textContent ?? null,
	}));

const browser = await launch();

// block scripts on for the site: the page renders but its scripts do not run
{
	const page = await openDemo(browser, PROXY);
	await page.evaluate((h) => {
		window.controller.shields.set(h, { blockScripts: true });
	}, host);
	await sleep(500); // let the shield reach the worker before the navigation
	await submitLanding(page, target);
	// the inject renders the DOM even with the page's scripts blocked
	const frame = await waitActive(
		page,
		() => !!document.getElementById('marker'),
	);
	const result = await report(frame);
	ok(
		'block scripts on: the page renders but neither the inline nor the external script ran',
		result.marker === 'unscripted' &&
			result.inlineRan === false &&
			result.extRan === false,
		JSON.stringify(result),
	);
	ok(
		'block scripts on: the page has no uncaught errors of the proxy',
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}

// block scripts off: the page's scripts run again, as they always did
{
	const page = await openDemo(browser, PROXY);
	await page.evaluate((h) => {
		window.controller.shields.set(h, { blockScripts: false });
	}, host);
	await sleep(500);
	await submitLanding(page, target);
	const frame = await waitActive(page, () => window.__inlineRan === true);
	const result = await report(frame);
	ok(
		'block scripts off: both the inline and the external script ran',
		result.marker === 'inline ran' &&
			result.inlineRan === true &&
			result.extRan === true,
		JSON.stringify(result),
	);
	await page.close();
}

// "Forget me when I close this site": the host clears the site's virtualized
// storage (localStorage, sessionStorage, IndexedDB, Cache Storage) through
// controller.forgetStorage once the last tab closes. Here we write a site's
// localStorage and a cache, call forgetStorage, and load the site again: both
// are gone. (The cookie jar half is covered by the cookies suite.)
{
	// the site's real origin, which its virtualized storage is keyed by (the
	// demo's forgetSiteOnClose reads it the same way, from the tab's real URL;
	// the proxied frame's location.origin is the proxy origin in same-origin mode)
	const siteOrigin = new URL(target).origin;
	const read = (frame) =>
		frame.evaluate(async () => ({
			local: localStorage.getItem('forgetme'),
			cached: await caches.has('forget-cache'),
		}));
	const page = await openDemo(browser, PROXY);
	await submitLanding(page, target);
	let frame = await waitActive(page, () => !!document.getElementById('marker'));
	// write the site's localStorage and a cache
	await frame.evaluate(async () => {
		localStorage.setItem('forgetme', 'kept');
		const cache = await caches.open('forget-cache');
		await cache.put('/forget-probe', new Response('kept'));
	});
	await sleep(800); // the localStorage write is sent to the worker asynchronously
	// reload the tab: a fresh document reads the stores back from the worker
	// (not its own shadow), confirming the writes landed and that this is the
	// state a "forget" has to clear
	await submitOmni(page, target);
	await sleep(400); // let the old document start unloading before we poll
	frame = await waitActive(page, () => !!document.getElementById('marker'));
	const before = await read(frame);
	ok(
		'the site wrote localStorage and a cache through the proxy',
		before.local === 'kept' && before.cached === true,
		JSON.stringify(before),
	);
	// forget the site, then load it again: the stores are gone
	await page.evaluate((o) => window.controller.forgetStorage(o), siteOrigin);
	await sleep(500);
	await submitOmni(page, target);
	await sleep(400);
	frame = await waitActive(page, () => !!document.getElementById('marker'));
	const after = await read(frame);
	ok(
		'forget me on close: the localStorage entry and the cache are gone',
		after.local === null && after.cached === false,
		JSON.stringify(after),
	);
	await page.close();
}

await done(browser);
