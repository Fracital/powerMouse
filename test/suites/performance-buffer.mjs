// A page's resource timing buffer is its own (test/pages/perf-buffer.js,
// test/perf.mjs): its size, the event that says it is full and what an
// observer is told was dropped read as they do natively, the proxy's own
// requests (the inject bundles, the synchronous bridge's beacons, the
// worker's routes) take none of its 250 entries, and no entry of them shows
// through any way of reading, in a document, a frame and a worker.
import { done, launch, ok } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const NATIVE_RUNS = Number(process.env.NATIVE_RUNS) || 2;
const browser = await launch();

/** every URL the page's browser asked for, to ask the page's entries by */
const watch = () => {
	const urls = new Set();
	return {
		prepare: (page) =>
			page.context().on('request', (request) => urls.add(request.url())),
		drive: async (page, frame) => {
			const names = [...urls, frame.url()];
			await frame.evaluate((names) => {
				const out = { entries: 0, byType: 0, routes: 0 };
				for (const name of names) {
					// (natively the names are the page's own: only a route counts)
					if (!/\/stomp\//.test(name)) continue;
					out.entries += performance.getEntriesByName(name).length;
					out.byType += performance.getEntriesByName(name, 'resource').length;
				}
				out.routes = performance
					.getEntries()
					.filter((entry) => /\/stomp\//.test(entry.name)).length;
				window.__perfDriven = out;
			}, names);
		},
	};
};

const CASES = [
	[
		'small',
		[
			['a small buffer fills, tells and takes more as natively', /^small\./],
			["a worker's buffer does as natively", /^worker\./],
		],
	],
	[
		'default',
		[["the browser's own 250 entries are all the page's", /^whole\./]],
	],
	['frame', [["a frame's 250 entries are all its own", /^frame\./]]],
];
const COMMON = [
	[
		"no entry is the proxy's own, by any way of reading",
		/^(machinery|byBrowserName)\b/,
	],
];

for (const [name, groups] of CASES) {
	const query = `&case=${name}`;
	const natives = [];
	for (let i = 0; i < NATIVE_RUNS; i++)
		natives.push(
			await nativeRecord(browser, 'buffer', {
				query,
				label: `${name}-native${i}`,
				timeout: 90000,
				...watch(),
			}),
		);
	if (
		!ok(
			`natively, the ${name} case ran every time`,
			natives.every((native) => native?.machinery),
		)
	)
		continue;
	for (const [mode, base] of MODES) {
		const { record, errors } = await proxiedRecord(browser, base, 'buffer', {
			query,
			label: `${name}-${mode}`,
			timeout: 90000,
			...watch(),
		});
		if (
			!ok(
				`${mode}: the ${name} case ran`,
				!!record?.machinery,
				errors.join(' | '),
			)
		)
			continue;
		report(`${mode}, ${name}`, differences(natives, record), [
			...groups,
			...COMMON,
		]);
	}
}
await done(browser);
