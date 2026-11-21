// Refreshes test/suite-seconds.json, the seconds test/run.mjs cuts CI's
// shards by, from the summary tables (`console.table`) in CI jobs' logs:
//
//   node test/suite-seconds.mjs <job log>...
//
// Each suite gets the median of its seconds over the logs given. A row whose
// suite was run again (failed, then ran alone) counts its two runs together,
// so it is left out when other logs have the suite without a rerun. A suite
// no log names keeps its number, and one no longer in test/suites/ is
// dropped. Give it the logs of recent green runs on the machine CI runs on:
// shards cut by stale or foreign numbers end minutes apart.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = `${root}test/suite-seconds.json`;
const logs = process.argv.slice(2);
if (!logs.length) {
	console.error('usage: node test/suite-seconds.mjs <job log>...');
	process.exit(2);
}

// │ 12 │ 'name' │ pass │ fail │ exit │ seconds │ 'rerun' │ (colours aside)
const ROW =
	/^│\s*\d+\s*│\s*'([^']+)'\s*│\s*\d+\s*│\s*\d+\s*│\s*(?:-?\d+|null)\s*│\s*(\d+)\s*│(?:\s*'([a-z]*)'\s*│)?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const seen = new Map();
for (const log of logs)
	for (const line of readFileSync(log, 'utf8').split('\n')) {
		const match = ROW.exec(line.replace(ANSI, ''));
		if (!match) continue;
		const [, name, seconds, rerun] = match;
		const runs = seen.get(name) ?? [];
		runs.push({ seconds: Number(seconds), rerun: Boolean(rerun) });
		seen.set(name, runs);
	}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2
		? sorted[mid]
		: Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const old = JSON.parse(readFileSync(file, 'utf8'));
const names = readdirSync(`${root}test/suites/`)
	.filter((name) => name.endsWith('.mjs'))
	.map((name) => name.slice(0, -4))
	.sort();
const out = {};
let measured = 0;
for (const name of names) {
	const runs = seen.get(name);
	if (runs) {
		const plain = runs.filter((run) => !run.rerun);
		out[name] = median((plain.length ? plain : runs).map((r) => r.seconds));
		measured++;
	} else if (old[name] !== undefined) out[name] = old[name];
}
writeFileSync(file, `${JSON.stringify(out, null, '\t')}\n`);
console.log(
	`${file}: ${measured} suites from ${logs.length} logs, ` +
		`${Object.keys(out).length - measured} kept, ` +
		`${names.length - Object.keys(out).length} with no number`,
);
