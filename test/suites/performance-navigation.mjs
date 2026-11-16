// What navigation timing and the two older interfaces (performance.timing,
// performance.navigation) show a document after each kind of navigation is
// what they show it natively (test/pages/perf-navigation.js, test/perf.mjs),
// in both demo modes.
import { done, launch, ok } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const NATIVE_RUNS = Number(process.env.NATIVE_RUNS) || 3;
const STEPS = [
	'direct',
	'redirected',
	'crossRedirected',
	'fromCross',
	'reloaded',
	'serverTiming',
	'back',
];
const browser = await launch();

const natives = [];
for (let i = 0; i < NATIVE_RUNS; i++)
	natives.push(
		await nativeRecord(browser, 'navigation', { label: `native${i}` }),
	);
ok(
	'natively, the page made every navigation each time',
	natives.every((native) => STEPS.every((step) => native?.[step])),
);

const GROUPS = [
	[
		'each navigation has the native type and redirect count',
		/\.(type|redirectCount|jsonType|jsonRedirectCount|redirect\.\w+)$/,
	],
	['each has the native name', /\.(name|jsonName|byName|byNameTyped)$/],
	['each has the native times (zero, ordered)', /\.times\./],
	['each has the native Server-Timing', /\.(serverTiming|jsonServerTiming)\b/],
	['performance.timing reads as natively', /\.timing\./],
	['performance.navigation reads as natively', /\.navigation\./],
];
const EXPECTED = [];

for (const [mode, base] of MODES) {
	const { record, errors } = await proxiedRecord(browser, base, 'navigation', {
		label: mode,
	});
	if (
		!ok(
			`${mode}: the page made every navigation`,
			STEPS.every((step) => record?.[step]),
			errors.join(' | '),
		)
	)
		continue;
	report(mode, differences(natives, record), GROUPS, EXPECTED);
}
await done(browser);
