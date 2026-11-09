// The synchronous bridge's request headers (src/syncHeaders.ts): a plain
// record, a list of pairs and a Headers of any realm all reach the service
// worker as a record. The bridge tested a record for `=== null`, so a record
// (jsonAPI's content-type, every cookie and storage call) was dropped and
// only a Headers of the bundle's own realm went through.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP sync-headers: esbuild is not installed');
}

if (esbuild) {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	mkdirSync(OUT, { recursive: true });
	const entry = `${OUT}sync-headers-entry.mjs`;
	writeFileSync(
		entry,
		`export { headersRecord } from ${JSON.stringify(`${root}src/syncHeaders.ts`)};\n`,
	);
	const bundle = `${OUT}sync-headers.mjs`;
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundle,
		logLevel: 'silent',
	});
	const { headersRecord } = await import(`${bundle}?${Date.now()}`);
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

	ok(
		'a plain record reaches the worker',
		same(headersRecord({ 'Content-Type': 'application/json' }), {
			'content-type': 'application/json',
		}),
		JSON.stringify(headersRecord({ 'Content-Type': 'application/json' })),
	);
	ok(
		'a Headers reaches the worker',
		same(headersRecord(new Headers({ 'x-stomp-load': 'image no-cors' })), {
			'x-stomp-load': 'image no-cors',
		}),
	);
	ok(
		'a list of pairs reaches the worker, a repeated name joined',
		same(
			headersRecord([
				['Accept', 'a'],
				['accept', 'b'],
			]),
			{ accept: 'a, b' },
		),
		JSON.stringify(
			headersRecord([
				['Accept', 'a'],
				['accept', 'b'],
			]),
		),
	);
	// another realm's Headers is no instance of this one's: a stand-in with
	// the same iteration
	const foreign = {
		forEach(callback) {
			callback('1', 'x-foreign');
		},
	};
	ok(
		"another realm's Headers reaches the worker",
		same(headersRecord(foreign), { 'x-foreign': '1' }),
		JSON.stringify(headersRecord(foreign)),
	);
	ok(
		'no headers send none',
		headersRecord(undefined) === undefined && headersRecord(null) === undefined,
	);
}

await done();
