// Build assets/adblock-snapshot.dat.gz, the built-in blocker's engine
// snapshot (docs/adblock.md, "The snapshot"): the lists of SNAPSHOT_LISTS
// (src/blocker/types.ts, uBlock Origin's own) fetched as they are now,
// compiled by assets/blocker.wasm as the service worker compiles them,
// serialized (Engine::serialize) and gzipped. A worker with no engine stored
// serves it while it fetches the default lists, so a first visit is filtered
// without waiting for the list servers. The file is stored compressed, and
// the worker decompresses it (DecompressionStream), so it is small however a
// host serves it.
//
//   node scripts/adblock-snapshot.mjs           make it again
//   node scripts/adblock-snapshot.mjs --check   exit 1 if it is stale
//
// The lists change every day and the snapshot only bridges the seconds until
// the worker's own build, so it is made again now and then, not on every
// build. assets/adblock-snapshot.UPSTREAM records the lists' digests, the
// module's, the file's and the date. It must be made again whenever
// blocker.wasm changes (its serialization is the crate's): build.js refuses
// a snapshot whose UPSTREAM names another module or another file. `--check`
// (the nightly workflow) also says it is stale once its lists are more than
// MAX_AGE_DAYS old.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, gzipSync } from 'node:zlib';

const MAX_AGE_DAYS = 14;
const root = new URL('../', import.meta.url);
const path = (name) => new URL(name, root).pathname;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FILE = 'assets/adblock-snapshot.dat.gz';
const UPSTREAM = 'assets/adblock-snapshot.UPSTREAM';

if (process.argv.includes('--check')) {
	const upstream = readFileSync(path(UPSTREAM), 'utf8');
	const field = (name) =>
		new RegExp(`^${name.replace('.', '\\.')} (.+)$`, 'm').exec(upstream)?.[1];
	const problems = [];
	if (
		field('blocker.wasm sha256') !==
		sha256(readFileSync(path('assets/blocker.wasm')))
	)
		problems.push('it was made by another blocker.wasm');
	if (field('sha256') !== sha256(readFileSync(path(FILE))))
		problems.push(`${FILE} is not the file its UPSTREAM describes`);
	const fetched = Date.parse(field('fetched') ?? '');
	const days = (Date.now() - fetched) / 86_400_000;
	if (!(days <= MAX_AGE_DAYS))
		problems.push(
			`its lists were fetched ${field('fetched') ?? 'at no recorded date'}, more than ${MAX_AGE_DAYS} days ago`,
		);
	if (problems.length) {
		console.error(
			`${FILE} is stale: ${problems.join('; ')}. Run node scripts/adblock-snapshot.mjs and commit the result.`,
		);
		process.exit(1);
	}
	console.log(`${FILE}: fresh (lists of ${field('fetched')})`);
	process.exit(0);
}

const { build } = await import('esbuild');
const work = mkdtempSync(join(tmpdir(), 'stomp-snapshot-'));
try {
	const entry = join(work, 'entry.mjs');
	writeFileSync(
		entry,
		`export { BlockerInstance, OP, FLAG_TRUSTED } from ${JSON.stringify(path('src/blocker/instance.ts'))};\n` +
			`export { compileModule } from ${JSON.stringify(path('src/wasm/module.ts'))};\n` +
			`export { SNAPSHOT_LISTS } from ${JSON.stringify(path('src/blocker/types.ts'))};\n`,
	);
	const bundle = join(work, 'bundle.mjs');
	await build({
		entryPoints: [entry],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2022',
		outfile: bundle,
		logLevel: 'silent',
	});
	const { BlockerInstance, OP, FLAG_TRUSTED, compileModule, SNAPSHOT_LISTS } =
		await import(bundle);
	const wasm = readFileSync(path('assets/blocker.wasm'));
	const builder = new BlockerInstance(await compileModule(wasm));
	const upstream = [];
	for (const list of SNAPSHOT_LISTS) {
		const response = await fetch(list.url);
		if (!response.ok)
			throw new Error(`status ${response.status} for ${list.url}`);
		const text = await response.text();
		if (builder.call(text, OP.addList | (list.trusted ? FLAG_TRUSTED : 0)))
			throw new Error(`the engine refused ${list.url}`);
		upstream.push(`list ${list.url} sha256 ${sha256(text)}`);
	}
	if (builder.call('', OP.build)) throw new Error('the engine did not build');
	const bytes = builder.bytes();
	// level 9, and the header carries no time or name: the same engine
	// gives the same file
	const gzipped = gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
	writeFileSync(path(FILE), gzipped);
	writeFileSync(
		path(UPSTREAM),
		[
			...upstream,
			`blocker.wasm sha256 ${sha256(wasm)}`,
			`bytes ${bytes.length}`,
			`gzip ${gzipped.length}`,
			`sha256 ${sha256(gzipped)}`,
			`fetched ${new Date().toISOString().slice(0, 10)}`,
			'built by scripts/adblock-snapshot.mjs',
			'',
		].join('\n'),
	);
	console.log(
		`${FILE}: ${gzipped.length} bytes (${bytes.length} decompressed)`,
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
