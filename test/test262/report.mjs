#!/usr/bin/env node
// The report of a test262 run (test/test262/run.mjs): counts, the difference
// set grouped by what the rewritten side said, the rewriter's robustness
// (rewrites that threw, scripts it declined that V8 compiles, hangs,
// timeouts) and its throughput on the corpus.
//
//   node test/test262/report.mjs [--out DIR] [--json FILE] [--top N]
//       [--known FILE] [--write-known FILE]
//
// --json writes every difference (file, variant, both verdicts). --known is
// the gate: FILE lists `<test path> <variant> <kind>` lines (# comments),
// the runs known to differ in verdict (kind `lost`: passes natively, fails
// rewritten; `gained`: the other way; `changed`: both fail, otherwise). The
// report exits 1 when a run outside the list differs, when a rewrite throws
// or a file hangs, or when a listed run of a file this run covered no longer
// differs that way (so the list stays true). --write-known writes the list
// this run would need.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};
const out = resolve(option('--out', join(ROOT, 'test/out/test262')));
const top = Number(option('--top', 15));
const rows = [];
for (const line of readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n'))
	if (line) rows.push(JSON.parse(line));
// a file run twice (a resumed run) counts once, the last time
const byFile = new Map(rows.map((row) => [row.file, row]));

const count = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sorted = (map) =>
	[...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
/** an error message with its particulars taken out, to group by */
const shape = (text) =>
	String(text ?? '')
		.replace(/REWRITE-THREW: [\s\S]*/, 'REWRITE-THREW')
		.replace(/«[^»]*»/g, '«»')
		.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""')
		.replace(/\b\d+(\.\d+)?\b/g, 'N')
		.slice(0, 140);
const dirOf = (file) => file.split('/').slice(0, 3).join('/');

const totals = {
	files: 0,
	skipped: 0,
	crashed: 0,
	hung: 0,
	runs: 0,
	nativePass: 0,
	proxiedPass: 0,
	bothPass: 0,
	lost: 0,
	gained: 0,
	changed: 0,
	message: 0,
	nativeFailNoise: 0,
	declinedNativeCompiles: 0,
	declinedNativeRefuses: 0,
	rewriteThrew: 0,
	proxiedTimeout: 0,
};
const skips = new Map();
const crashes = [];
const lostBy = new Map();
const lostByFeature = new Map();
const lostByDir = new Map();
const differences = [];
const verdictRuns = new Set();
const threw = [];
const perDir = new Map();
let rwBytes = 0;
let rwMs = 0;
let rwOut = 0;
const timed = [];

for (const row of byFile.values()) {
	totals.files++;
	if (row.skip) {
		totals.skipped++;
		count(skips, row.skip);
		continue;
	}
	if (row.crash) {
		if (row.crash === 'hang') totals.hung++;
		else totals.crashed++;
		crashes.push(row);
		continue;
	}
	const dir = dirOf(row.file);
	if (!perDir.has(dir))
		perDir.set(dir, {
			files: 0,
			runs: 0,
			nativePass: 0,
			bothPass: 0,
			lost: 0,
			gained: 0,
		});
	const tally = perDir.get(dir);
	tally.files++;
	if (row.rw) {
		if (row.rw.threw) {
			totals.rewriteThrew++;
			threw.push({ file: row.file, variant: 'alone', err: row.rw.threw });
		} else {
			rwBytes += row.bytes;
			rwMs += row.rw.ms;
			rwOut += row.rw.out;
			timed.push({ file: row.file, bytes: row.bytes, ms: row.rw.ms });
		}
	}
	for (const run of row.variants) {
		const { n, p } = run;
		totals.runs++;
		tally.runs++;
		if (n.ok) totals.nativePass++;
		if (p.ok) totals.proxiedPass++;
		if (n.ok) tally.nativePass++;
		if (p.phase === 'rewrite' || p.rewriteThrew) {
			totals.rewriteThrew++;
			threw.push({ file: row.file, variant: run.v, err: p.err });
		}
		if (p.declined) {
			if (n.phase === 'parse') totals.declinedNativeRefuses++;
			else totals.declinedNativeCompiles++;
		}
		if (n.ok && p.err?.startsWith('TIMEOUT')) totals.proxiedTimeout++;
		let kind = null;
		if (n.ok && p.ok) {
			totals.bothPass++;
			tally.bothPass++;
			if ((n.err ?? '') !== (p.err ?? '')) kind = 'message';
		} else if (n.ok) kind = 'lost';
		else if (p.ok) kind = 'gained';
		else if (
			n.phase !== p.phase ||
			n.err?.split(':')[0] !== p.err?.split(':')[0]
		)
			kind = 'changed';
		else {
			totals.nativeFailNoise++;
			if (n.err !== p.err) kind = 'message';
		}
		if (!kind) continue;
		totals[kind]++;
		if (kind !== 'message') verdictRuns.add(`${row.file} ${run.v} ${kind}`);
		if (kind === 'gained') tally.gained++;
		differences.push({
			kind,
			file: row.file,
			variant: run.v,
			features: row.features,
			flags: row.flags,
			native: n.ok ? 'pass' : `${n.phase} ${n.err}`,
			proxied: `${p.ok ? 'pass' : `${p.phase} ${p.err}`}${p.declined ? ' (declined)' : ''}`,
		});
		if (kind !== 'lost') continue;
		tally.lost++;
		const key = `${p.declined ? 'declined ' : ''}${p.phase} ${shape(p.err)}`;
		if (!lostBy.has(key))
			lostBy.set(key, { runs: 0, files: new Set(), example: row.file });
		const group = lostBy.get(key);
		group.runs++;
		group.files.add(row.file);
		count(lostByDir, row.file.split('/').slice(0, 4).join('/'));
		for (const feature of row.features.length ? row.features : ['(none)'])
			count(lostByFeature, feature);
	}
}

const lines = [];
const say = (line = '') => lines.push(line);
let meta = {};
try {
	meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
} catch {
	// (a run of an older runner: no meta)
}
say(
	`test262 ${meta.test262Head ?? '?'} node ${meta.node ?? '?'} core ${meta.core ?? '?'}`,
);
say(
	`files ${totals.files} (skipped ${totals.skipped}: ${JSON.stringify(Object.fromEntries(skips))}; crashed ${totals.crashed}; hung ${totals.hung})`,
);
say(
	`runs ${totals.runs}: native pass ${totals.nativePass}, rewritten pass ${totals.proxiedPass}, both ${totals.bothPass}`,
);
say(
	`lost (native pass, rewritten fail) ${totals.lost}; gained ${totals.gained}; changed ${totals.changed}; same verdict other message ${totals.message}; native-fail noise ${totals.nativeFailNoise}`,
);
say(
	`rewriter: threw ${totals.rewriteThrew}; declined a script V8 compiles ${totals.declinedNativeCompiles} (one V8 refuses ${totals.declinedNativeRefuses}); rewritten run timed out where native passed ${totals.proxiedTimeout}`,
);
const mbps = rwBytes / 1e6 / (rwMs / 1000);
say(
	`throughput (each test file alone, as its own kind of script): ${(rwBytes / 1e6).toFixed(2)} MB in ${(rwMs / 1000).toFixed(2)} s = ${mbps.toFixed(2)} MB/s; output ${(rwOut / rwBytes).toFixed(2)}x the input`,
);
const big = timed.filter((entry) => entry.bytes >= 20000);
if (big.length) {
	const bigBytes = big.reduce((sum, entry) => sum + entry.bytes, 0);
	const bigMs = big.reduce((sum, entry) => sum + entry.ms, 0);
	say(
		`  files of 20 KB and over: ${big.length}, ${(bigBytes / 1e6).toFixed(2)} MB at ${(bigBytes / 1e6 / (bigMs / 1000)).toFixed(2)} MB/s`,
	);
}
const ms = timed.map((entry) => entry.ms).sort((a, b) => a - b);
if (ms.length)
	say(
		`  per file ms: median ${ms[ms.length >> 1].toFixed(3)}, p99 ${ms[Math.floor(ms.length * 0.99)].toFixed(3)}, max ${ms[ms.length - 1].toFixed(3)}`,
	);
say();
say(`slowest rewrites (ms, bytes, MB/s, file):`);
for (const entry of [...timed].sort((a, b) => b.ms - a.ms).slice(0, top))
	say(
		`  ${entry.ms.toFixed(2)}  ${entry.bytes}  ${(entry.bytes / 1e3 / entry.ms).toFixed(2)}  ${entry.file}`,
	);
say(`lowest throughput among files of 10 KB and over (MB/s, ms, bytes, file):`);
for (const entry of timed
	.filter((item) => item.bytes >= 10000)
	.sort((a, b) => a.bytes / a.ms - b.bytes / b.ms)
	.slice(0, top))
	say(
		`  ${(entry.bytes / 1e3 / entry.ms).toFixed(2)}  ${entry.ms.toFixed(2)}  ${entry.bytes}  ${entry.file}`,
	);
say();
say('per directory: files runs nativePass bothPass lost gained');
for (const [dir, tally] of [...perDir].sort())
	say(
		`  ${dir} ${tally.files} ${tally.runs} ${tally.nativePass} ${tally.bothPass} ${tally.lost} ${tally.gained}`,
	);
say();
say(`lost runs by what the rewritten side said (runs, files, example):`);
for (const [key, group] of [...lostBy]
	.sort((a, b) => b[1].runs - a[1].runs)
	.slice(0, 60))
	say(`  ${group.runs} ${group.files.size}  ${key}\n      ${group.example}`);
say();
say(`lost runs by directory:`);
for (const [dir, runs] of sorted(lostByDir).slice(0, 40))
	say(`  ${runs} ${dir}`);
say(`lost runs by feature:`);
for (const [feature, runs] of sorted(lostByFeature).slice(0, 40))
	say(`  ${runs} ${feature}`);
if (threw.length) {
	say();
	say('rewrites that threw:');
	for (const entry of threw.slice(0, top))
		say(`  ${entry.file} ${entry.variant}: ${String(entry.err).slice(0, 300)}`);
}
if (crashes.length) {
	say();
	say('crashes and hangs:');
	for (const row of crashes)
		say(`  ${row.file}: ${row.crash} in "${row.stage}"`);
}
console.log(lines.join('\n'));
writeFileSync(join(out, 'report.txt'), `${lines.join('\n')}\n`);

const json = option('--json');
if (json) writeFileSync(json, `${JSON.stringify(differences, null, 1)}\n`);
const writeKnown = option('--write-known');
if (writeKnown)
	writeFileSync(
		writeKnown,
		`# test262 runs whose verdict differs rewritten (test/test262/report.mjs --known):\n# <test> <variant> lost|gained|changed. test262 ${meta.test262Head ?? '?'}\n${[...verdictRuns].sort().join('\n')}\n`,
	);

const knownFile = option('--known');
if (knownFile) {
	const known = new Set(
		existsSync(knownFile)
			? readFileSync(knownFile, 'utf8')
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith('#'))
			: [],
	);
	const fresh = [...verdictRuns].filter((run) => !known.has(run));
	// a listed run of a file this run covered that no longer differs so
	const stale = [...known].filter((run) => {
		const file = run.split(' ')[0];
		return byFile.has(file) && !verdictRuns.has(run);
	});
	const bad = [];
	if (fresh.length)
		bad.push(
			`${fresh.length} differ and are not listed:\n  ${fresh.slice(0, 30).join('\n  ')}`,
		);
	if (stale.length)
		bad.push(
			`${stale.length} listed that no longer differ so (take them off):\n  ${stale.slice(0, 30).join('\n  ')}`,
		);
	if (threw.length) bad.push(`${threw.length} rewrites threw`);
	if (totals.hung) bad.push(`${totals.hung} files hung`);
	if (bad.length) {
		console.log(`\nFAIL test262 gate\n${bad.join('\n')}`);
		process.exit(1);
	}
	console.log('\nPASS test262 gate');
}
