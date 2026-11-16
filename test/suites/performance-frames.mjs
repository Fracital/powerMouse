// A frame a page makes itself answers the page as it does natively
// (test/pages/perf-frames.js, test/perf.mjs): its performance object, its
// PerformanceObserver and its ReportingObserver, read in the very task that
// made the frame, a task later, after the page wrote a document into it and
// after the page removed it. Every URL they show is the page's own, none of
// the proxy's requests is an entry, and every function reads as the
// browser's.
import { done, launch, ok } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const browser = await launch();

const GROUPS = [
	["the page's own synchronous request is reported as natively", /^own\b/],
	['a frame read in the task that made it', /^sync\./],
	["a frame's natives, taken in the task that made it", /^kept\./],
	['an about:blank frame, a task later', /^later\./],
	['a frame the page wrote a document into', /^opened\./],
	["a removed frame's realm", /^removed\./],
	["the frames' loads are not the page's", /^parent\b/],
];
// What the architecture cannot close, each with why. One that reads as
// natively again fails the suite: take it off the list.
const EXPECTED = [
	[
		/^(sync|later|opened)\.load\.(heard|calls): /,
		"a frame on about:blank is no client of the service worker, so its loads are made by the page above it (Client.routedFetch) and the browser tells the frame's own PerformanceObserver nothing of them; the frame's performance object lists them",
	],
	[
		/^kept\.heard: /,
		"the same, for an observer made with the frame's constructor before anything ran in it",
	],
	[
		/^removed\.observer: 1 -> 0$/,
		"the same, for a buffered observer in a removed frame's realm",
	],
];

// (`own`: the page itself makes the first synchronous request)
for (const [name, query] of [
	['frames first', ''],
	['the page first', '&own=1'],
]) {
	const natives = [];
	for (let i = 0; i < 3; i++)
		natives.push(
			await nativeRecord(browser, 'frames', {
				query,
				label: `${query ? 'own-' : ''}native${i}`,
			}),
		);
	if (
		!ok(
			`natively (${name}), the page read every frame it made`,
			natives.every((native) => native?.removed?.before !== undefined),
		)
	)
		continue;
	for (const [mode, base] of MODES) {
		const { record, errors } = await proxiedRecord(browser, base, 'frames', {
			query,
			label: `${query ? 'own-' : ''}${mode}`,
		});
		if (
			!ok(
				`${mode} (${name}): the page read every frame it made`,
				record?.removed?.before !== undefined,
				errors.join(' | '),
			)
		)
			continue;
		report(`${mode} (${name})`, differences(natives, record), GROUPS, EXPECTED);
	}
}
await done(browser);
