#!/usr/bin/env node
// The protected demo site's leak gate (scripts/build-demo-site.mjs runs it):
// fails unless every file the site serves is clean of every canary and every
// script the site serves runs in estrogen's VM.
//
// - estrogen --check over the site, with the same canaries: a script no pass
//   would change, or a canary estrogen still sees, fails;
// - every served file (scripts, the service worker, workers, HTML, CSS, SVG,
//   JSON, wasm, images, gzip), read as it is served, searched for each canary
//   (case-insensitive): as written, percent-decoded, inside every base64 run
//   (data: URLs, inlined wasm) once decoded (as the list writes them), and
//   inside a gzip file once unpacked;
// - with --origin, the server's own answers too (/config.js, the APIs), as a
//   running demo serving the site gives them;
// - every .js/.mjs file against its copy before estrogen (<site>.native):
//   protected, and compiled to the VM, not left to the literal-pool fallback
//   (the counts @sysce/estrogen's verify-proxy-assets.mjs makes, with its
//   --require-full-vm).
//
// Usage: node scripts/demo-leak-gate.mjs <site> <canaries.json>
//        [--origin <url>] [--json <report.json>]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const [site, canaryFile, ...rest] = process.argv.slice(2);
const option = (name) => {
	const at = rest.indexOf(name);
	return at === -1 ? null : rest[at + 1];
};
if (!site || !canaryFile) {
	console.error(
		'Usage: node scripts/demo-leak-gate.mjs <site> <canaries.json> [--origin <url>] [--json <file>]',
	);
	process.exit(2);
}
const origin = option('--origin');
const canaries = JSON.parse(readFileSync(canaryFile, 'utf8')).canaries.map(
	({ value }) => value,
);
// (a canary that holds a shorter one is found where the shorter one is: the
// report names the shortest, and the search runs only those)
const lowered = [...new Set(canaries.map((value) => value.toLowerCase()))];
const needles = lowered.filter(
	(value) => !lowered.some((other) => other !== value && value.includes(other)),
);
const exactNeedles = [...new Set(canaries)].filter(
	(value) =>
		!canaries.some((other) => other !== value && value.includes(other)),
);
const failures = [];

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.isFile()) yield path;
	}
}

/** a byte string's latin1 text, lowercased: canaries are ASCII */
const text = (bytes) => bytes.toString('latin1').toLowerCase();
/** the views of a body to search: as served, and every encoding undone */
function views(bytes) {
	// (as served, less its long base64 runs: random text there spells a
	// short canary in some case now and then, and the runs are searched
	// decoded below)
	const unbased = (body) =>
		body.replace(/[a-z0-9+/]{64,}/g, (run) => ' '.repeat(run.length));
	const out = [['plain', unbased(text(bytes))]];
	if (bytes[0] === 0x1f && bytes[1] === 0x8b)
		try {
			out.push(
				...views(gunzipSync(bytes)).map(([k, ...v]) => [`gzip+${k}`, ...v]),
			);
		} catch {
			// (not gzip after all: searched as it is)
		}
	const raw = bytes.toString('latin1');
	if (/%[0-9a-f]{2}/i.test(raw))
		out.push([
			'url-encoded',
			// (less the long base64 runs, as the plain view: the same noise)
			unbased(
				raw
					.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
						String.fromCharCode(Number.parseInt(hex, 16)),
					)
					.toLowerCase(),
			),
		]);
	const runs = [];
	for (const [run] of raw.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g))
		// (base64 or base64url, read from the run's start as embedded data
		// is; decoded noise is searched for the canaries as written, not
		// case-folded, so a run of random text seldom matches by chance)
		runs.push(
			Buffer.from(
				run.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''),
				'base64',
			).toString('latin1'),
		);
	if (runs.length) out.push(['base64', runs.join('\n'), true]);
	return out;
}
function scan(name, bytes) {
	const found = new Map();
	const plain = new Map();
	for (const [form, body, exact] of views(bytes))
		for (const needle of exact ? exactNeedles : needles) {
			const count = body.split(needle).length - 1;
			if (!count) continue;
			if (form === 'plain') plain.set(needle, count);
			// (percent-decoding that finds only what the plain view did adds
			// nothing)
			if (form.endsWith('url-encoded') && plain.get(needle) === count) continue;
			found.set(`${needle} (${form})`, count);
		}
	if (found.size)
		failures.push({
			check: 'canary',
			file: name,
			leaks: Object.fromEntries(found),
		});
	return found.size === 0;
}

// estrogen's own check, with the same list
const check = spawnSync(
	join(root, 'node_modules/.bin/estrogen'),
	['--check', '-v', '--canary', canaryFile, site],
	{ cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 },
);
const checkReport = `${check.stdout}${check.stderr}`;
const files = [...walk(site)].sort();
const clean = new Set();
for (const path of files)
	if (scan(relative(site, path), readFileSync(path)))
		clean.add(relative(site, path));
if (check.status !== 0) {
	// estrogen 0.5.4 calls a plain icon SVG with nothing to rewrite
	// unprotected (fixed in 0.5.5): such a file passes when it is `unchanged`
	// and clean of every canary by the scan above
	const svgOnly = checkReport
		.split('\n')
		.filter((line) => /^\s+unchanged\s/.test(line))
		.map((line) => relative(site, line.trim().split(/\s+/)[1]));
	const unchanged = svgOnly.every(
		(name) => name.endsWith('.svg') && clean.has(name),
	);
	const otherwise = checkReport
		.split('\n')
		.filter((line) => /^estrogen: /.test(line))
		.filter((line) => !/eligible file\(s\) are unprotected/.test(line));
	if (!unchanged || otherwise.some((line) => !/file\(s\):/.test(line)))
		failures.push({
			check: 'estrogen --check',
			report: checkReport
				.split('\n')
				.filter((line) => !/^\s+(obfuscated|skipped)\s/.test(line))
				.join('\n')
				.trim(),
		});
}

// VM coverage: each script against its copy before estrogen
const native = `${site}.native`;
const coverage = { files: 0, vm: 0, fallback: 0, unprotected: 0, list: [] };
if (existsSync(native))
	for (const path of walk(native)) {
		if (!/\.(js|mjs|cjs)$/.test(path)) continue;
		const name = relative(native, path);
		const code = existsSync(join(site, name))
			? readFileSync(join(site, name), 'utf8')
			: '';
		const kind = !code.startsWith('/* generated by https://estro.help */')
			? 'unprotected'
			: code.includes('JSON.parse(')
				? 'vm'
				: 'fallback';
		coverage.files++;
		coverage[kind]++;
		if (kind !== 'vm') coverage.list.push({ file: name, kind });
	}
else failures.push({ check: 'vm', error: `no ${native} to hold it against` });
if (coverage.files && coverage.vm !== coverage.files)
	failures.push({ check: 'vm', ...coverage });

// the server's own answers
const served = [
	'/',
	'/config.js',
	'/api/status',
	'/api/tor',
	'/api/commits',
	'/webtransport.json',
	'/manifest.webmanifest',
];
if (origin)
	for (const path of served) {
		const response = await fetch(new URL(path, origin)).catch(() => null);
		if (!response?.ok) continue;
		const headers = [...response.headers]
			.map(([key, value]) => `${key}: ${value}`)
			.join('\n');
		scan(
			`${origin.replace(/\/$/, '')}${path}`,
			Buffer.concat([
				Buffer.from(`${headers}\n\n`),
				Buffer.from(await response.arrayBuffer()),
			]),
		);
	}

const report = {
	site,
	canaries: canaries.length,
	searched: needles.length,
	files: files.length,
	clean: clean.size,
	vm: coverage,
	failures,
};
const jsonOut = option('--json');
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, '\t')}\n`);
console.log(
	`demo-leak-gate: ${files.length} file(s), ${clean.size} clean; ${coverage.vm}/${coverage.files} script(s) in the VM, ${coverage.fallback} fallback, ${coverage.unprotected} unprotected; ${canaries.length} canaries (${needles.length} searched)`,
);
for (const failure of failures) {
	if (failure.check === 'canary')
		console.log(
			`LEAK ${failure.file}: ${Object.entries(failure.leaks)
				.map(([key, count]) => `${key} x${count}`)
				.join(', ')}`,
		);
	else
		console.log(`FAIL ${failure.check}: ${JSON.stringify(failure, null, 1)}`);
}
console.log(failures.length ? 'demo-leak-gate: FAIL' : 'demo-leak-gate: PASS');
process.exit(failures.length ? 1 : 0);
