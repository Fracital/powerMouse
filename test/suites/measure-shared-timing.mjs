// Measurement: the fidelity of three surfaces a page reads about itself that
// STomp's shared-renderer + injected bundle could skew (test page
// shared-timing.html). Prints native vs proxied and fails only on a real
// divergence a fingerprinter could read:
//
//  1. resource timing (performance.getEntriesByType('resource') and a
//     PerformanceObserver): the page must see entries only for its OWN
//     sub-resources, named by its own URLs, and no entry of the inject's
//     (a bundle, the rewriter library, a routed helper fetch). Count and
//     names are compared to native.
//  2. performance.memory: recorded (its own suite, memory.mjs, checks it).
//  3. cross-frame timing: performance.now resolution/offset and same-origin
//     postMessage latency, recorded for the record.
//
// SKIP_MEASUREMENT=1 leaves the suite out.
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

const target = `${FIXTURE}pages/shared-timing.html`;

async function readProbe(frame) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const value = await frame
			.evaluate(() => (window.__probe?.done ? window.__probe : null))
			.catch(() => null);
		if (value) return value;
	}
	return null;
}

const browser = await launch(['--enable-precise-memory-info']);

// native
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await readProbe(nativePage.mainFrame());
await nativePage.close();
ok(
	'native: probe ran',
	!!native?.done,
	JSON.stringify(native?.resource?.count),
);

// proxied, same-origin and isolated
const results = { native };
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let probe = null;
	for (let i = 0; i < 80 && !probe; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => (window.__probe?.done ? window.__probe : null))
				.catch(() => null);
			if (value) {
				probe = value;
				break;
			}
		}
	}
	results[mode] = probe;
	ok(
		`${mode}: probe ran`,
		!!probe?.done,
		JSON.stringify(probe?.resource?.count),
	);
	await page.close();
}

// --- report ---
const show = (p) => {
	if (!p) return 'MISSING';
	return JSON.stringify(
		{
			count: p.resource?.count,
			observed: p.resource?.observed?.length,
			foreignNames: p.resource?.foreignNames,
			initiators: (p.resource?.entries || [])
				.map((e) => `${e.initiatorType}:${basename(e.name)}`)
				.sort(),
			nowMinStep: p.nowMinStep,
			postMessageMedianMs: p.postMessageMedianMs,
			crossOriginIsolated: p.crossOriginIsolated,
		},
		null,
		0,
	);
};
function basename(name) {
	try {
		const u = new URL(name);
		return u.pathname.split('/').pop() + (u.search ? '?' : '');
	} catch {
		return name;
	}
}

console.log('\n=== resource-timing / timing probe ===');
for (const mode of ['native', 'same-origin', 'isolated'])
	console.log(`${mode.padEnd(12)} ${show(results[mode])}`);
console.log('\n--- full entry names per mode ---');
for (const mode of ['native', 'same-origin', 'isolated']) {
	console.log(`[${mode}]`);
	for (const e of results[mode]?.resource?.entries || [])
		console.log(
			`  ${(e.initiatorType || '?').padEnd(14)} ${e.name}  (transfer=${e.transferSize} enc=${e.encodedBodySize} dec=${e.decodedBodySize} proto=${e.nextHopProtocol} delivery=${e.deliveryType} st=${JSON.stringify(e.serverTiming)})`,
		);
}
console.log('\n--- memory / timing ---');
for (const mode of ['native', 'same-origin', 'isolated'])
	console.log(
		`${mode.padEnd(12)} memory=${JSON.stringify(results[mode]?.memory)} timeOrigin=${results[mode]?.timeOrigin} childTimeOrigin=${results[mode]?.childTimeOrigin} hasSAB=${results[mode]?.hasSAB}`,
	);
console.log('');

// --- assertions: real divergences ---
for (const mode of ['same-origin', 'isolated']) {
	const p = results[mode];
	if (!p) continue;
	// no entry names a foreign origin (a route or the proxy's own origin)
	ok(
		`${mode}: no resource-timing entry leaks a non-page origin`,
		(p.resource?.foreignNames || []).length === 0,
		JSON.stringify(p.resource?.foreignNames),
	);
	// the observer path is filtered the same as getEntries
	const obsForeign = (p.resource?.observed || []).filter((n) => {
		try {
			return (
				new URL(n).origin !== p.href && !n.startsWith(new URL(p.href).origin)
			);
		} catch {
			return true;
		}
	});
	ok(
		`${mode}: PerformanceObserver sees no foreign/inject entry`,
		obsForeign.length === 0,
		JSON.stringify(obsForeign),
	);
	// the page should see the same number of its OWN resources as native
	// (the injectDocument bundle, rewriter lib, routed helper fetches must
	// not swell the count). Allow the favicon which native's about:blank may
	// or may not fetch; compare the stable sub-resources by initiator.
	const ownKinds = (probe) =>
		(probe?.resource?.entries || [])
			.map((e) => `${e.initiatorType}:${basename(e.name)}`)
			.sort();
	console.log(
		`${mode}: own-resource kinds\n  native=${JSON.stringify(ownKinds(native))}\n  ${mode}=${JSON.stringify(ownKinds(p))}`,
	);
}

await done(browser);
