// The Performance and Reporting interfaces look to a page as they do
// natively (test/pages/perf-shapes.js, test/perf.mjs), in a document and in
// a dedicated worker: every constructor and every member of every prototype
// has the native descriptor, name, length and source text, a call on the
// wrong receiver throws the native error from the native place, and the
// objects a page holds (performance, an entry, performance.memory) have the
// native own keys and prototype chains.
import { done, launch, ok } from '../lib.mjs';
import {
	differences,
	MODES,
	nativeRecord,
	proxiedRecord,
	report,
} from '../perf.mjs';

const browser = await launch();
const natives = [
	await nativeRecord(browser, 'shapes', { label: 'native0' }),
	await nativeRecord(browser, 'shapes', { label: 'native1' }),
];
ok(
	'natively, the page described every interface',
	natives.every((native) => native?.worker?.Performance?.members),
);

const GROUPS = [
	['the objects a page holds have the native keys and chains', /^instances\./],
	['performance.memory has the native shape', /^memory\b/],
	["a worker's interfaces have the native shapes", /^worker\./],
	[
		'a call on the wrong receiver throws as natively',
		/\.(wrong|wrongSet|called)\b/,
	],
	['every member has the native descriptor, name, length and source', /./],
];

for (const [mode, base] of MODES) {
	const { record, errors } = await proxiedRecord(browser, base, 'shapes', {
		label: mode,
	});
	if (
		!ok(
			`${mode}: the page described every interface`,
			!!record?.worker,
			errors.join(' | '),
		)
	)
		continue;
	report(mode, differences(natives, record), GROUPS);
}
await done(browser);
