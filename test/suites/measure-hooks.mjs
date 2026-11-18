// Measurement: what the inject's hooks add to the page work they sit on.
// test/pages/measure-hooks.js holds the kernels (reads of location,
// document.cookie, top, parent and frames; innerHTML, element insertion
// with scripts and links; URL and plain attributes; fetch, XHR and
// postMessage setup; mutation observers), run in a frame of another site
// than its parent, as an embed is. Each is timed in the page natively (the
// fixture server's page) and through the proxy in same-origin mode, and the
// table is the median round of each and the ratio. `control` touches no
// hook: its ratio is the noise of the run.
//
// The check that is no measurement: every kernel computes the same checksum
// natively and through the proxy.
//
//   RUNS     browsers, one after another (default 1); the table shows the
//            median of the runs
//   ROUNDS   timed rounds of a kernel per run (default 7), WARM warm-up
//            rounds before them (default 2)
//   ONLY     kernels to run, by name, comma separated
//   PROFILE  a path: the proxied run's CPU profile is written there
//   REPORT   a path: every run's timings are written there as JSON
//
// SKIP_MEASUREMENT=1 leaves the suite out.
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
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

const RUNS = Number(process.env.RUNS) || 1;
const query = new URLSearchParams();
for (const [name, key] of [
	['ROUNDS', 'rounds'],
	['WARM', 'warm'],
	['ONLY', 'only'],
])
	if (process.env[name]) query.set(key, process.env[name]);
const url = `${FIXTURE}pages/measure-hooks.html?${query}`;
const TIMEOUT = 5 * 60 * 1000;

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
};

/** the report of whichever frame of the page ran the kernels */
async function report(page) {
	const start = Date.now();
	while (Date.now() - start < TIMEOUT) {
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => (window.__hooks?.done ? window.__hooks : null))
				.catch(() => null);
			if (value) return value;
		}
		await sleep(500);
	}
	throw new Error('no frame finished the kernels');
}

const natives = [];
const proxieds = [];
let version = '?';
for (let run = 0; run < RUNS; run++) {
	const browser = await launch();
	try {
		version = browser.version().split('.')[0];
		const page = await browser.newPage();
		await page.goto(url);
		natives.push(await report(page));
		await page.close();

		const tab = await openDemo(browser, PROXY);
		let session;
		if (process.env.PROFILE && run === 0) {
			session = await tab.context().newCDPSession(tab);
			await session.send('Profiler.enable');
			await session.send('Profiler.setSamplingInterval', { interval: 100 });
			await session.send('Profiler.start');
		}
		await submitLanding(tab, url);
		proxieds.push(await report(tab));
		if (session) {
			const { profile } = await session.send('Profiler.stop');
			writeFileSync(process.env.PROFILE, JSON.stringify(profile));
		}
		ok(
			`run ${run + 1}: the proxied page raised no error`,
			tab.errors.length === 0,
			tab.errors.join(' | ').slice(0, 300),
		);
	} finally {
		await browser.close();
	}
}

const names = natives[0].order;
console.log(
	`\nChrome ${version}, ${RUNS} run(s) of ${natives[0].rounds} rounds, load ${loadavg()
		.map((value) => value.toFixed(1))
		.join(' ')}`,
);
console.log(
	`  ${'kernel'.padEnd(28)} ${'native ms'.padStart(10)} ${'proxied ms'.padStart(11)} ${'ratio'.padStart(8)}`,
);
for (const name of names) {
	const native = median(natives.map((entry) => entry.kernels[name].ms));
	const proxied = median(proxieds.map((entry) => entry.kernels[name]?.ms));
	console.log(
		`  ${name.padEnd(28)} ${native.toFixed(2).padStart(10)} ${proxied.toFixed(2).padStart(11)} ${(proxied / native).toFixed(2).padStart(8)}`,
	);
}
console.log('');
if (process.env.REPORT)
	writeFileSync(process.env.REPORT, JSON.stringify({ natives, proxieds }));

ok(
	'every run timed the same kernels',
	[...natives, ...proxieds].every(
		(entry) => entry.order.join() === names.join(),
	),
	proxieds.map((entry) => entry.order.length).join(' / '),
);
for (const name of names) {
	const native = natives[0].kernels[name].checksum;
	const answers = [...natives, ...proxieds].map(
		(entry) => entry.kernels[name]?.checksum,
	);
	ok(
		`${name}: the same checksum natively and through the proxy`,
		answers.every((answer) => answer === native),
		`${native} natively, ${answers.at(-1)} proxied`,
	);
}
await done(null);
