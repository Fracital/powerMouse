// A stylesheet is rewritten the same whatever was rewritten before it, in
// node. css-tree keeps its token buffer from one parse to the next and reads
// one entry of it that the new parse never writes: when a sheet's outermost
// block closes, the bracket it then waits for is the pair of the token at
// index `source.length` of the buffer, which is whatever an earlier, longer
// sheet left there (TokenStream.setSource). With an opening bracket there, a
// closing bracket with nothing open (`a{} } b{}`) was matched against it and
// the balance table went round in a circle: the sheet's rewrite differed
// from the same sheet's in a new thread, and for some sheets the parser's
// recovery never ended (it made nodes until the service worker's heap was
// gone; 32 characters did it). src/rewriteCSS.ts clears the buffer after
// each parse. Every sheet here is rewritten first in a thread of its own and
// then after a sheet that leaves each kind of opening bracket where the
// buffer is read, and the two outputs are compared.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP css-parse-history: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}css-parse-history-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyCSS } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
`,
);
const bundle = `${OUT}css-parse-history.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	// css-tree reads a data file next to itself: resolved from node_modules
	external: ['css-tree'],
	outfile: bundle,
	logLevel: 'silent',
});
// a thread of its own: css-tree's buffer as a new service worker has it, and
// a rewrite that never ends can be stopped
const thread = `${OUT}css-parse-history-thread.mjs`;
writeFileSync(
	thread,
	`import { parentPort, workerData } from 'node:worker_threads';
const { modifyCSS, StompURL, parseConfig } = await import(${JSON.stringify(bundle)});
const { codec } = parseConfig({ directory: '/stomp/', codec: 'xor' }, 'k');
const url = new StompURL('https://example.com/dir/sheet.css', codec, '/stomp/');
console.error = () => {};
console.warn = () => {};
const outputs = [];
for (const [text, context] of workerData) {
	try {
		outputs.push(modifyCSS(text, url, context));
	} catch (error) {
		outputs.push('THROWN ' + String(error));
	}
}
parentPort.postMessage(outputs);
`,
);

/** the rewrites of `sheets` ([text, context]), one after another in a new thread; null when they did not end */
const rewrites = (sheets) =>
	new Promise((resolve) => {
		const worker = new Worker(thread, {
			workerData: sheets,
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
		const timer = setTimeout(() => {
			void worker.terminate();
			resolve(null);
		}, 20000);
		const settle = (value) => {
			clearTimeout(timer);
			resolve(value);
		};
		worker.once('message', (outputs) => {
			void worker.terminate();
			settle(outputs);
		});
		worker.once('error', () => settle(null));
		worker.once('exit', () => settle(null));
	});

// closing brackets with nothing open, where css-tree read its old buffer
const SHEETS = [
	['{ b: url(]c) }\0 @media }\0 @media', 'stylesheet'],
	['a { b: url(c) } } d { e: url(f) }', 'stylesheet'],
	['a{} } b{c:url(d)}', 'stylesheet'],
	['a{} ) b{c:url(d)} @import "e";', 'stylesheet'],
	['a{} ] b{c:url(d)} ] @media (x) { f { g: url(h) } }', 'stylesheet'],
	['@media (x) { a { b: url(c) } } } d { e: image-set("f" 1x) }', 'stylesheet'],
	['a { b: url(c) } ) ) } ] e { f: url(g) }', 'stylesheet'],
	['a: url(b); } c: url(d)', 'declarationList'],
	['a: (b) ) url(c); d: url(e)', 'declarationList'],
	// and a balanced one, which never depended on it
	['a { b: url(c) } d { e: url(f) }', 'stylesheet'],
];
/** a sheet (with something to route, or it is never parsed) whose token at index `length` is `opener`: what the next parse of a sheet that long reads */
const before = (length, opener) =>
	`${';'.repeat(length)}${opener} a { b: url(c) }`;
const OPENERS = ['{', '(', '[', 'f('];

let ended = 0;
let same = 0;
const differences = [];
for (const [text, context] of SHEETS) {
	const alone = await rewrites([[text, context]]);
	for (const opener of OPENERS) {
		const after = await rewrites([
			[before(text.length, opener), 'stylesheet'],
			[text, context],
		]);
		if (after) ended++;
		if (alone && after && after[1] === alone[0]) same++;
		else if (differences.length < 3)
			differences.push({ text, opener, alone, after: after?.[1] ?? null });
	}
}
const pairs = SHEETS.length * OPENERS.length;
ok(
	'every rewrite ends, whatever sheet came before',
	ended === pairs,
	`${ended} of ${pairs}`,
);
ok(
	'and is the rewrite of the same sheet in a new thread',
	same === pairs,
	`${same} of ${pairs} ${JSON.stringify(differences)}`,
);
{
	// the two sheets a fuzz found it with: the second never ended
	const first = `${'a { b: url(c) }'.repeat(4)}\\29 a { b: url( { b: url(c) }${'a { b: url(c) }'.repeat(2)}\\29 ${'a { b: url(c) }'.repeat(17)}a { b: `;
	const second = SHEETS[0];
	const alone = await rewrites([second]);
	const after = await rewrites([[first, 'stylesheet'], second]);
	ok(
		'the pair of sheets that never ended',
		alone !== null && after !== null && after[1] === alone[0],
		JSON.stringify({ alone, after: after?.[1] ?? null }),
	);
}

await done();
