// A script that comes as UTF-8 is rewritten from its bytes to the bytes of
// its output (src/wasm/rewriteBytes.ts), in a rewrite worker or the service
// worker, in node: the output must be modifyJS's of the text the bytes
// decode to as a script file (SCRIPT_FILE: with its position map), encoded,
// byte for byte, and where the module does not answer
// for the bytes (no UTF-8, a script it declines, a thread with no module)
// it answers null, for the caller to rewrite the decoded text instead. The
// scripts: the suites' pages' and fixtures' scripts, and the shapes of
// each fallback. And the service worker's read of a script's body
// (src/server/bodyBytes.ts): its bytes handed to a worker are had again
// when the worker does not answer.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP rewrite-bytes: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}rewrite-bytes-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyJS, SCRIPT_FILE } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { adoptModule } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
export { rewriteBytesInWasm } from ${JSON.stringify(`${root}src/wasm/rewriteBytes.ts`)};
export { BodyBytes } from ${JSON.stringify(`${root}src/server/bodyBytes.ts`)};
`,
);
const bundle = `${OUT}rewrite-bytes.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const thread = await import(bundle);

const config = {
	directory: '/stomp/',
	codec: 'xor',
	names: { client: '$Bq7xK2mPzR' },
	rewriter: 'wasm',
};
const url = new thread.StompURL(
	'https://example.com/dir/a.js',
	thread.parseConfig(config, 'k').codec,
	'/stomp/',
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const show = (value) => JSON.stringify(value).slice(0, 300);
const same = (a, b) =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);
/** the bytes path's Blob as its bytes (null as it is) */
const bytesPath = async (...args) => {
	const blob = thread.rewriteBytesInWasm(...args);
	return blob && new Uint8Array(await blob.arrayBuffer());
};
// (the console's warnings of the scripts handed back)
const warn = console.warn;
console.warn = () => {};

const types = ['generic', 'genericModule', 'worker', 'workerModule'];
const fallback = (bytes, type, preamble) =>
	encoder.encode(
		thread.modifyJS(
			decoder.decode(bytes),
			url,
			config,
			type,
			preamble,
			thread.SCRIPT_FILE,
		),
	);

ok(
	'a thread with no module answers null',
	thread.rewriteBytesInWasm(
		encoder.encode('top.x = 1;'),
		url,
		config,
		'generic',
	) === null,
);
thread.adoptModule(
	'core',
	await WebAssembly.compile(readFileSync(`${root}dist/core.wasm`)),
);

// the suites' scripts, each as every type that parses it
const files = [];
for (const dir of ['test/pages', 'test/fixtures', 'test/corpus/sample'])
	for (const name of readdirSync(`${root}${dir}`, { recursive: true }))
		if (/\.m?js$/.test(name)) files.push(`${dir}/${name}`);
let answered = 0;
let compared = 0;
const differ = [];
for (const file of files) {
	const bytes = readFileSync(`${root}${file}`);
	for (const type of types) {
		const output = await bytesPath(bytes, url, config, type);
		compared++;
		if (output === null) continue;
		answered++;
		if (!same(output, fallback(bytes, type, '')))
			differ.push(`${file} ${type}`);
	}
}
ok(
	`the bytes' output is the decoded text's, encoded (${compared} rewrites of ${files.length} scripts, ${answered} answered from the bytes)`,
	differ.length === 0 && answered > compared / 2,
	show(differ),
);

// what the bytes path answers null for, and the decoded text's rewrite then
const CASES = {
	'a byte order mark goes, as the decoder drops it': {
		bytes: [0xef, 0xbb, 0xbf, ...encoder.encode('"use strict"; top.x = 1;')],
		answers: true,
	},
	"a second byte order mark goes too, as the text's rewrite reads its output back":
		{
			bytes: [
				0xef,
				0xbb,
				0xbf,
				0xef,
				0xbb,
				0xbf,
				...encoder.encode('top.x = 1;'),
			],
			answers: true,
		},
	'text that is no UTF-8 is left to the decoder (U+FFFD for its bad bytes)': {
		bytes: [
			...encoder.encode('x = "a'),
			0xff,
			0xfe,
			...encoder.encode('b"; top.y = x;'),
		],
		answers: false,
	},
	'a script the module declines is left to modifyJS (its end, its warning)': {
		bytes: [...encoder.encode("x = '")],
		answers: false,
	},
	'markup served as a script is left to modifyJS': {
		bytes: [...encoder.encode('<!doctype html><p>Not found')],
		answers: false,
	},
	'text past ASCII and the line separators cross as they are': {
		bytes: [
			...encoder.encode(
				'const ü = "日本語   ✓"; function g() { return window.top[ü]; }',
			),
		],
		answers: true,
	},
	'an empty script': { bytes: [], answers: true },
};
for (const [name, { bytes, answers }] of Object.entries(CASES)) {
	const given = new Uint8Array(bytes);
	const output = await bytesPath(given, url, config, 'generic');
	const expected = fallback(given, 'generic', '');
	ok(
		name,
		answers ? output !== null && same(output, expected) : output === null,
		show({
			output: output && decoder.decode(output),
			expected: decoder.decode(expected),
		}),
	);
}

// a preamble and a worker's bootstrap go where the text's rewrite puts them
{
	const bytes = encoder.encode('"use strict"; self.onmessage = () => top;');
	const preamble = 'document.currentScript;';
	const results = [];
	for (const type of types) {
		const output = await bytesPath(bytes, url, config, type, preamble);
		results.push(
			output !== null && same(output, fallback(bytes, type, preamble)),
		);
	}
	ok(
		"a preamble and the lead of each type, as the text's rewrite writes them",
		results.every(Boolean),
		show(results),
	);
}

// a body read for a worker: its bytes, the same after they were handed over
{
	const text = encoder.encode('top.x = "\u00e9t\u00e9";\n'.repeat(300));
	const streamOf = (chunks) =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
		);
	const pieces = [];
	for (let at = 0; at < text.length; at += 1000)
		pieces.push(text.slice(at, at + 1000));
	const many = await thread.BodyBytes.read(streamOf(pieces));
	const given = many.handOver();
	const own = given === many.bytes.buffer;
	structuredClone(given, { transfer: [given] });
	ok(
		"a body of many chunks hands over its bytes' own buffer and has them again",
		own &&
			many.size === text.length &&
			given.byteLength === 0 &&
			same(many.bytes, text),
		show({ own, size: many.size, again: many.bytes.length }),
	);
	// one chunk that is part of a larger buffer: a copy of it goes
	const wide = new Uint8Array(text.length + 20);
	wide.set(text, 10);
	const one = await thread.BodyBytes.read(
		streamOf([wide.subarray(10, 10 + text.length)]),
	);
	const copy = one.handOver();
	const copied =
		copy.byteLength === text.length && same(new Uint8Array(copy), text);
	structuredClone(copy, { transfer: [copy] });
	ok(
		'a body of one chunk hands over a copy of just its bytes',
		copied && same(one.bytes, text) && wide.byteLength === text.length + 20,
	);
	const fetched = await thread.BodyBytes.read(new Response(text));
	const none = await thread.BodyBytes.read(new Response(null));
	ok(
		'a body read as arrayBuffer() reads it: the bytes, none for no body',
		same(fetched.bytes, text) && none.size === 0 && none.bytes.length === 0,
	);
	let refused = null;
	try {
		await thread.BodyBytes.read(streamOf(['top.x = 1;']));
	} catch (error) {
		refused = error;
	}
	ok(
		'a chunk that is no bytes is a TypeError, as arrayBuffer() says',
		refused instanceof TypeError,
		String(refused),
	);
}

console.warn = warn;
await done();
