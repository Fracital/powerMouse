// A site's own Server-Timing metrics named like the service worker's marks
// (stomp-tao, stomp-cached, ...: PROXY_METRICS in src/transport/messages.ts)
// read through the proxy as they read natively, in both demo modes: the
// page sees them in resource timing, in its navigation timing and in the
// headers of a fetch or an XMLHttpRequest, and they change nothing else of
// its entries (restriction, sizes, delivery, encoding, initiator, which
// entries there are). The page (test/pages/perf-server-timing.html, served
// by test/perf-server.mjs) loads a script, images of its own origin and of
// another with and without Timing-Allow-Origin, cors fetches of another
// origin with and without it and with and without the header exposed, and
// an XMLHttpRequest, each answered with the metrics below, as its document
// is.
import { done, launch, ok } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const METRICS = [
	'stomp-tao',
	'stomp-tao-denied;dur=1',
	'stomp-cors',
	'stomp-size;dur=5;desc="9"',
	'stomp-unreported',
	'stomp-encoding;desc=gzip',
	'stomp-worker-script',
	'stomp-opaque',
	'stomp-timing-only',
	'stomp-xhr',
	'stomp-cached',
	'stomp-revalidated',
	'stomp-memory',
	'stomp-kept',
	'stomp-hops;dur=2',
	'stomp-!odd;dur=3',
	'app;dur=4;desc="a, stomp-cached"',
].join(', ');
const query = `&st=${encodeURIComponent(METRICS)}`;

const NATIVE_RUNS = Number(process.env.NATIVE_RUNS) || 3;
const browser = await launch();

const natives = [];
for (let i = 0; i < NATIVE_RUNS; i++)
	natives.push(
		await nativeRecord(browser, 'server-timing', {
			query,
			label: `native${i}`,
		}),
	);
ok(
	'natively, the page made its loads every time',
	natives.every((native) => native?.navigation),
);
ok(
	'natively, the metrics are there to be read',
	natives.every(
		(native) =>
			native?.navigation?.metrics?.[0] === 'stomp-tao|0|' &&
			native.headers.fetch?.startsWith('stomp-tao, '),
	),
	JSON.stringify(natives[0]?.navigation?.metrics),
);

const GROUPS = [
	['the page made the same loads', /^steps\./],
	[
		"a load's entry shows the site's metrics",
		/^resources\.[^.]+\.(serverTiming|metrics)\b/,
	],
	["a load's entry reads as natively otherwise", /^resources\./],
	["the document's navigation entry shows the site's metrics", /^navigation\./],
	['a response shows its Server-Timing header as natively', /^headers\./],
];

for (const [mode, base] of MODES) {
	const { record, errors } = await proxiedRecord(
		browser,
		base,
		'server-timing',
		{ query, label: mode },
	);
	if (
		!ok(
			`${mode}: the page made its loads`,
			!!record?.navigation,
			errors.join(' | '),
		)
	)
		continue;
	report(mode, differences(natives, record), GROUPS);
}
await done(browser);
