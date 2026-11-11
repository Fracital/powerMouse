// How long a proxied top takes from its navigation start to its first
// page-side rewrite answered (a measurement: numbers that depend on the
// machine, left out of a gate run). The inject bundles carry no parser: a
// top's shell loads the rewriter library's file before the bundle, from the
// HTTP cache (the controller fetched it when it started): `warm`. `cold` is
// the same navigation with the browser's cache emptied first, as when a
// host opens a proxied page before that fetch landed. The page
// (test/pages/first-rewrite.html) makes a function from a string and notes
// the time. Where a realm had to make a request for the library, how long
// it waited is printed too.
//
//   RUNS  browsers, one after another (default 3)
//   WARM  navigations per browser after the first (default 10)
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

const RUNS = Number(process.env.RUNS) || 3;
const WARM = Number(process.env.WARM) || 10;
const page = (n) => `${FIXTURE}pages/first-rewrite.html?n=${n}`;

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

/** the active frame once it shows navigation `n`: when its first rewrite was answered and what the rewrites of its library cost */
async function landed(tab, n) {
	const frame = await waitActive(
		tab,
		`typeof window.__first === 'object' && new URLSearchParams(window.__first.href.split('?')[1]).get('n') === '${n}'`,
	);
	const name = await tab.evaluate(() => window.controller.config.names.client);
	return frame.evaluate(
		(name) => ({
			at: window.__first.at,
			// absent before the library became an asset
			counts: window[name]?.rewriteCounts ?? null,
		}),
		name,
	);
}

const first = [];
const every = [];
const warm = [];
const cold = [];
const waits = [];
const coldWaits = [];
for (let run = 0; run < RUNS; run++) {
	const browser = await launch();
	try {
		const tab = await openDemo(browser, PROXY);
		await submitLanding(tab, page(0));
		first.push((await landed(tab, 0)).at);
		const times = [];
		for (let n = 1; n <= WARM; n++) {
			await submitOmni(tab, page(n));
			const result = await landed(tab, n);
			times.push(result.at);
			if (result.counts?.requests) waits.push(result.counts.ms);
		}
		warm.push(median(times));
		every.push(...times);
		const session = await tab.context().newCDPSession(tab);
		await session.send('Network.clearBrowserCache');
		await session.detach();
		await sleep(200);
		await submitOmni(tab, page('cold'));
		const result = await landed(tab, 'cold');
		cold.push(result.at);
		if (result.counts?.requests) coldWaits.push(result.counts.ms);
	} finally {
		await browser.close();
	}
}

const list = (values) => values.map((value) => value.toFixed(1)).join(' / ');
console.log(
	`first navigation of a browser: ${list(first)} ms to the first rewrite`,
);
console.log(`warm (median of ${WARM}): ${list(warm)} ms`);
every.sort((a, b) => a - b);
console.log(
	`warm, all ${every.length} navigations: median ${median(every).toFixed(1)} ms, lower quartile ${every[Math.floor(every.length / 4)].toFixed(1)} ms, least ${every[0].toFixed(1)} ms`,
);
console.log(`cold (cache emptied): ${list(cold)} ms`);
if (waits.length)
	console.log(
		`the library's load, warm: median ${median(waits).toFixed(2)} ms, max ${Math.max(...waits).toFixed(2)} ms (${waits.length} tops)`,
	);
if (coldWaits.length)
	console.log(`the library's load, cold: ${list(coldWaits)} ms`);
ok(
	`every run answered a first rewrite`,
	warm.length === RUNS && cold.length === RUNS,
);
await done(null);
