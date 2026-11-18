// Measurement: what rewritten code costs at run time. The rewriter routes
// every computed member access through the access API (`a[i]` is
// `$s$j.get2(a, i, ...)`, `a[i] = v` is `$s$j.set2(...)`, `o[k](x)` is
// `$s$j.call2(...)`, `k in o` is `$s$j.has(k, o)`), so code that does little
// else (loops over arrays and typed arrays, an image kernel, a tree walk)
// pays the helper on every element. test/pages/measure-compute.js holds the
// kernels; each is timed in the page, natively (the fixture server's page)
// and through the proxy (the same page, rewritten, with the real inject),
// and the table is the median round of each and the ratio. `control` reads
// no member and `string-charcodeat` is not routed: their ratios are the
// noise of the run.
//
// The check that is no measurement: every kernel computes the same checksum
// natively and through the proxy.
//
//   RUNS    browsers, one after another (default 1); the table shows the
//           median of the runs
//   ROUNDS  timed rounds of a kernel per run (default 5), WARM warm-up
//           rounds before them (default 2)
//   ONLY    kernels to run, by name, comma separated
//
// The checks hold on any machine, so a gate run (SKIP_MEASUREMENT=1, as CI
// runs) keeps the suite (test/run.mjs GATED) and times one round of each
// kernel with no warm-up unless ROUNDS or WARM say otherwise: the table is
// noise there, the checksums are what is checked.
import { loadavg } from 'node:os';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const RUNS = Number(process.env.RUNS) || 1;
const query = new URLSearchParams();
for (const [name, key] of [
	['ROUNDS', 'rounds'],
	['WARM', 'warm'],
	['ONLY', 'only'],
])
	if (process.env[name]) query.set(key, process.env[name]);
if (process.env.SKIP_MEASUREMENT === '1') {
	if (!process.env.ROUNDS) query.set('rounds', '1');
	if (!process.env.WARM) query.set('warm', '0');
}
const url = `${FIXTURE}pages/measure-compute.html?${query}`;
// a proxied kernel can take a hundred times its native time
const TIMEOUT = 8 * 60 * 1000;

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
};

const natives = [];
const proxieds = [];
let version = '?';
for (let run = 0; run < RUNS; run++) {
	const browser = await launch();
	try {
		version = browser.version().split('.')[0];
		const page = await browser.newPage();
		await page.goto(url);
		await page.waitForFunction(() => window.__compute?.done, null, {
			timeout: TIMEOUT,
		});
		natives.push(await page.evaluate(() => window.__compute));
		await page.close();

		const tab = await openDemo(browser, PROXY);
		await submitLanding(tab, url);
		const frame = await waitActive(
			tab,
			'window.__compute?.done === true',
			TIMEOUT,
		);
		proxieds.push(await frame.evaluate(() => window.__compute));
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
	`  ${'kernel'.padEnd(20)} ${'native ms'.padStart(10)} ${'proxied ms'.padStart(11)} ${'ratio'.padStart(8)}`,
);
for (const name of names) {
	const native = median(natives.map((report) => report.kernels[name].ms));
	const proxied = median(proxieds.map((report) => report.kernels[name]?.ms));
	console.log(
		`  ${name.padEnd(20)} ${native.toFixed(1).padStart(10)} ${proxied.toFixed(1).padStart(11)} ${(proxied / native).toFixed(2).padStart(8)}`,
	);
}
console.log('');

ok(
	`every run timed the same kernels`,
	[...natives, ...proxieds].every(
		(report) => report.order.join() === names.join(),
	),
	proxieds.map((report) => report.order.length).join(' / '),
);
for (const name of names) {
	const native = natives[0].kernels[name].checksum;
	const answers = [...natives, ...proxieds].map(
		(report) => report.kernels[name]?.checksum,
	);
	ok(
		`${name}: the same checksum natively and through the proxy`,
		answers.every((answer) => answer === native),
		`${native} natively, ${answers.at(-1)} proxied`,
	);
}
await done(null);
