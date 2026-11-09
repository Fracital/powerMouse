// The synchronous bridge carries the service worker's answer in cookies of
// at most 4000 characters (src/encodeCookie.ts splitAnswer and joinAnswer),
// checked in node at every length around the chunk boundaries. The worker
// counted the chunks from the whole answer, so an answer a character or two
// past a multiple of 4000 lost its last piece and the page's JSON.parse
// threw "Bad control character" (malformed-headers failed about every other
// run once its jar grew to that size). Skips when esbuild is not installed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP sync-chunks: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}sync-chunks-entry.mjs`;
writeFileSync(
	entry,
	`export * from ${JSON.stringify(`${root}src/encodeCookie.ts`)};\n`,
);
const bundle = `${OUT}sync-chunks.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { decodeCookie, encodeCookie, joinAnswer, splitAnswer, SYNC_CHUNK } =
	await import(`${bundle}?${Date.now()}`);

const id = 'sync-request-4f2a9c';
// what document.cookie shows: other cookies around the answer, one of them a
// different request whose id starts with this one's
const jar = (cookies) =>
	[
		'a=1',
		`${id}9=other`,
		...cookies.map(([name, value]) => `${name}=${value}`),
		`${id}f=2,stranger`,
		'z=2',
	].join('; ');

// encoded answers of every length up to four chunks and a bit, with escapes
// (%22, %u00e9) falling on every boundary
const pattern = encodeCookie('a"b,céd').repeat(4 * SYNC_CHUNK);
const lost = [];
const oversized = [];
for (let length = 1; length <= 4 * SYNC_CHUNK + 10; length++) {
	const encoded = pattern.slice(0, length);
	const cookies = splitAnswer(id, encoded);
	if (cookies.some(([, value]) => value.length > SYNC_CHUNK))
		oversized.push(length);
	if (joinAnswer(jar(cookies), id)?.value !== encoded) lost.push(length);
}
// and whole texts, decoded, either side of the first boundaries
for (const length of [3990, 3998, 3999, 4000, 4001, 7998, 7999, 8000, 8001]) {
	const text = '{"k":"' + 'x'.repeat(length - 8) + '"}';
	const answer = joinAnswer(jar(splitAnswer(id, encodeCookie(text))), id);
	if (decodeCookie(answer?.value ?? '') !== text) lost.push(`text ${length}`);
}
ok(
	'every answer up to four chunks long comes back whole',
	lost.length === 0,
	`lost at encoded lengths ${lost.slice(0, 10).join(' ')}`,
);
ok(
	'no cookie of an answer is over the chunk size',
	oversized.length === 0,
	`at encoded lengths ${oversized.slice(0, 10).join(' ')}`,
);

const encoded = 'x'.repeat(2 * SYNC_CHUNK + 1);
const cookies = splitAnswer(id, encoded);
ok(
	'the main cookie is set last, after every chunk it counts',
	cookies.at(-1)[0] === id && cookies.length === 3,
	JSON.stringify(cookies.map(([name, value]) => [name, value.length])),
);
ok(
	'an answer with a chunk not there yet is not read',
	joinAnswer(jar(cookies.filter(([name]) => name !== `${id}1`)), id) === null,
);
ok(
	'the cookies to clear are the answer and its chunks, no other',
	JSON.stringify(joinAnswer(jar(cookies), id)?.names) ===
		JSON.stringify([id, `${id}0`, `${id}1`]),
);
await done();
