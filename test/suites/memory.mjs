// performance.memory per site (the Memory module). Every proxied site shares
// the proxy's one renderer process, so performance.memory is the whole
// process's heap and a frame reads the same figure as the page that embeds
// it; natively, each site its own process, they never match (Cloudflare
// Turnstile rejects a challenge frame whose heap equals its embedder's). The
// module gives each site its own figure. Checked against native, both demo
// modes: the child of another site differs from its embedding top as
// natively, agrees with its own about:blank helper, moves up as the site
// allocates, and is stable across a reload of the same site.
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

const CHILD = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const target = `${FIXTURE}pages/memory.html?child=${encodeURIComponent(CHILD)}`;
const MB = 1048576;

/** the top page's report once its child and the child's helper have answered */
async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => (window.__mem?.role === 'top' ? window.__mem : null))
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch(['--enable-precise-memory-info']);

// natively: the child of another site is its own process
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, performance.memory is exposed',
	native?.supported && native.child?.used > 0,
	JSON.stringify(native?.child),
);
ok(
	'natively, the child of another site differs from its embedding top',
	native && native.child.used !== native.after.used,
	JSON.stringify({ top: native?.after?.used, child: native?.child?.used }),
);
ok(
	// same process, one shared heap: close (each realm's own 50 ms cache
	// jitters by a few KB), never the megabytes a different process differs by
	'natively, the child is within 256 KB of its own about:blank helper',
	native && Math.abs(native.child.used - native.blank.used) < 256 * 1024,
	JSON.stringify({ child: native?.child?.used, blank: native?.blank?.used }),
);
const nativeLimit = native?.child?.limit;

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: performance.memory is exposed`,
		proxied?.supported && proxied.child?.used > 0,
		JSON.stringify(proxied?.child),
	);
	// exact, not bucketed or frozen: after allocating 2 MB and letting the
	// 50 ms cache expire, the figure moves by about that much at byte
	// granularity (Chrome locks a renderer to one site and reports exact
	// figures; without site isolation they are coarse buckets that do not
	// move). Natively a separate process moves the same way.
	const moved = (r) => (r?.grown?.used ?? 0) - (r?.child?.used ?? 0);
	ok(
		`${mode}: the figure is exact and moves finely as the site allocates, as natively`,
		proxied &&
			moved(proxied) > 1 * MB &&
			moved(proxied) < 24 * MB &&
			moved(native) > 1 * MB,
		JSON.stringify({ proxied: moved(proxied), native: moved(native) }),
	);
	// the signal Turnstile reads: a frame must not equal its embedder
	ok(
		`${mode}: the child of another site differs from its embedding top, as natively`,
		proxied &&
			proxied.child.used !== proxied.after.used &&
			proxied.child.used !== proxied.before.used,
		JSON.stringify({
			top: proxied?.after?.used,
			child: proxied?.child?.used,
		}),
	);
	ok(
		`${mode}: the child agrees with its own about:blank helper, as natively`,
		proxied && proxied.child.used === proxied.blank.used,
		JSON.stringify({
			child: proxied?.child?.used,
			blank: proxied?.blank?.used,
		}),
	);
	// the child allocated 4 MB; its figure is plausibly small, not the
	// process's whole heap (which the host and every other site share)
	ok(
		`${mode}: the child's figure is a plausible per-site heap, not the shared process heap`,
		proxied && proxied.child.used < 64 * MB && proxied.after.used < 128 * MB,
		JSON.stringify({ child: proxied?.child?.used, top: proxied?.after?.used }),
	);
	ok(
		`${mode}: jsHeapSizeLimit is the browser's, as natively`,
		proxied && nativeLimit && proxied.child.limit === nativeLimit,
		JSON.stringify({ proxied: proxied?.child?.limit, native: nativeLimit }),
	);
	ok(
		`${mode}: totalJSHeapSize is at least usedJSHeapSize`,
		proxied && proxied.child.total >= proxied.child.used,
		JSON.stringify(proxied?.child),
	);

	// stable across a reload of the same site: the baseline is the site's, so
	// the child's starting figure repeats
	const again = await openDemo(browser, base);
	await submitLanding(again, target);
	const reloaded = await report(again);
	ok(
		`${mode}: the site's figure is stable across a reload (within 3 MB)`,
		reloaded &&
			proxied &&
			Math.abs(reloaded.child.used - proxied.child.used) < 3 * MB,
		JSON.stringify({
			first: proxied?.child?.used,
			second: reloaded?.child?.used,
		}),
	);
	await again.close();
	await page.close();
}

// The "Block fingerprinting" shield, off: the site reads the renderer's native
// performance.memory, so the Turnstile tell returns (a frame equals its
// embedder in the proxy's one process). The inject leaves the Memory module
// out for a host whose shields set blockFingerprinting off (Config.noFingerprint,
// src/server/shields.ts). On (the default, checked above) the emulation stands.
{
	const top = new URL(FIXTURE).hostname;
	const childHost = new URL(CHILD).hostname;
	const page = await openDemo(browser, PROXY);
	await page.evaluate(
		([a, b]) => {
			window.controller.shields.set(a, { blockFingerprinting: false });
			window.controller.shields.set(b, { blockFingerprinting: false });
		},
		[top, childHost],
	);
	await sleep(500); // let the shields reach the worker before the navigation
	await submitLanding(page, target);
	const off = await report(page);
	ok(
		'fingerprint off: performance.memory is still exposed and the inject is intact',
		off?.supported && off.child?.used > 0 && off.after?.used > 0,
		JSON.stringify({ top: off?.after?.used, child: off?.child?.used }),
	);
	// with the emulation on (the checks above) the child's figure is a small
	// per-site floor, ~1-2 MB; off, both frames read the renderer's real,
	// multi-MB shared heap (the native values the shield exposes). 4 MB sits
	// well above the floor and below the real heap seen here (~18-27 MB).
	ok(
		'fingerprint off: the child reads the real process heap, not the emulated per-site floor',
		off && off.child.used > 4 * MB && off.after.used > 4 * MB,
		JSON.stringify({ top: off?.after?.used, child: off?.child?.used }),
	);
	await page.close();
}

await done(browser);
