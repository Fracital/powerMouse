// What resource timing shows a page of its own loads is what it shows the
// page loaded natively, in both demo modes (docs/performance.md). The page
// (test/pages/perf-resources.html, served by test/perf-server.mjs) loads a
// mix: scripts (classic, module, dynamic import, preloaded), style sheets
// and what they load, fonts, images, fetch and XMLHttpRequest, another
// origin's with and without cors and Timing-Allow-Origin, redirect chains,
// the caches (HTTP, memory, a 304), failures (a 404, an aborted and a
// refused request), Server-Timing, compressed bodies, a range, an
// EventSource, a WebSocket, a beacon, Early Hints, frames (same origin,
// another origin, srcdoc, about:blank, one added later) and workers
// (dedicated, shared, service), each of which reports its own entries.
//
// Compared, wherever three native runs agree (test/perf.mjs): which entries
// there are and their order, and of each entry its name, initiatorType,
// nextHopProtocol, deliveryType, responseStatus, renderBlockingStatus,
// contentType, contentEncoding, the three sizes, serverTiming, the worker
// fields, which times are zero, whether they are in order, which are equal,
// and toJSON's keys and values. Times themselves are never compared.
//
// EXPECTED lists what the architecture does not close, each with its reason
// (docs/performance.md); one that starts matching fails the suite. One
// entry is a browser version's behaviour instead, and is listed only for
// the version it was measured on (ASKS_AGAIN).
import { done, launch, ok } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const NATIVE_RUNS = Number(process.env.NATIVE_RUNS) || 3;
const browser = await launch();

const natives = [];
for (let i = 0; i < NATIVE_RUNS; i++)
	natives.push(
		await nativeRecord(browser, 'resources', { label: `native${i}` }),
	);
ok(
	'natively, the page loaded its mix every time',
	natives.every((native) => native?.resources),
);

const GROUPS = [
	['the page made the same loads', /^(steps|ran|markup|href)\b/],
	[
		'the entries are the same set, in the same order',
		/^(sequence|observed|all|byName|apart)\b/,
	],
	['each entry has the native name', /^resources\.[^.]+\.(name|jsonName)$/],
	[
		'each entry has the native sizes',
		/^resources\.[^.]+\.(transferSize|encodedBodySize|decodedBodySize)$/,
	],
	[
		'each entry has the native times (zero, ordered, equal)',
		/^resources\.[^.]+\.times\./,
	],
	[
		'each entry has the native Server-Timing',
		/^resources\.[^.]+\.serverTiming|^serverTimingArray\./,
	],
	['each entry has every other native field', /^resources\./],
	['a frame sees its own entries as natively', /^frames\./],
	['a worker sees its own entries as natively', /^workers\./],
];

// Measured, not an architecture's limit: through the proxy Chrome 152 asks
// the origin a second time for an image of the markup that no cache may
// keep (its parser does not take what its preload scanner fetched: two
// requests reach the origin, two entries), and Chrome 156 does not (one
// request, one entry, as natively). The versions between were not measured:
// on those the count is held to native's, and a failure there says which
// way they go.
const ASKS_AGAIN = Number(browser.version().split('.')[0]) <= 152;

const EXPECTED = [
	...(ASKS_AGAIN
		? [
				[
					/^apart\.(img-nostore|img404)\.count: 1 -> 2$/,
					'Chrome 152 only: an image in the markup that no cache may keep is asked for by the preload scanner and again by the parser, with an entry each (Chrome 156 asks once)',
				],
			]
		: []),
	[
		/^apart\.xhr-sync\./,
		'a synchronous XMLHttpRequest has no entry: it travels over the synchronous bridge, not as a load of the browser',
	],
	[
		/^resources\.hint#0\.times\./,
		'an interim response (103) is not seen: the transport hands over the final response only',
	],
	[
		/^resources\.gzip-chunked#0\.(encodedBodySize|transferSize)/,
		'a compressed body without a Content-Length counts as its decoded bytes: the transport decodes it and does not say how long it came',
	],
	[
		/^workers\.(dedicated|shared)\.resources\.perf-lib\.js\./,
		"a worker's entry for a script the rewrite cache kept reads as the HTTP cache's: a worker cannot be told how the load was delivered",
	],
	[
		/^workers\.service\.resources\..+\.times\./,
		"an emulated service worker's importScripts entry has the sizes natively (its script cache's) but not a network load's final headers time",
	],
	[
		/^frames\.frame-srcdoc\.navigation\.(en|de)codedBodySize/,
		"a srcdoc frame's navigation entry has the sizes of the shell written into the frame, not of the page's srcdoc text",
	],
];

for (const [mode, base] of MODES) {
	const { record, errors } = await proxiedRecord(browser, base, 'resources', {
		label: mode,
	});
	if (
		!ok(
			`${mode}: the page loaded its mix`,
			!!record?.resources,
			errors.join(' | '),
		)
	)
		continue;
	report(mode, differences(natives, record), GROUPS, EXPECTED);
}
await done(browser);
