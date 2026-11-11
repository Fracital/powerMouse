// The wasm rewriter's glue (src/wasm/rewriter.ts) asks a module for a
// rewrite only when the module answers the revision the glue was written
// against, in node. The module is an asset of its own: a host that serves
// an older one beside newer bundles (a cache in front of it, half a deploy)
// hands every thread a module that speaks something else. The phase 0
// artifact answered every call with a copy of its input and status 0: as
// the rewriter's answer that is the script as the page wrote it, its `top`
// and `location` the real ones. So a thread that holds such a module
// rewrites in JavaScript, and the build's own module answers the glue's
// revision (rust/rwjs/src/rewrite.rs REVISION, rust/host/cases.revision).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP wasm-rewriter-glue: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}wasm-rewriter-glue-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyJS, singleExpression } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { adoptModule } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
export { REVISION, rewriterRevision } from ${JSON.stringify(`${root}src/wasm/rewriter.ts`)};
`,
);
const bundle = `${OUT}wasm-rewriter-glue.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['css-tree'],
	outfile: bundle,
	logLevel: 'silent',
});
// two threads: one that never holds a module (the JavaScript rewriter) and
// one that is handed them
const plain = await import(`${bundle}?js`);
const thread = await import(`${bundle}?wasm`);

const config = { directory: '/stomp/', codec: 'xor', rewriter: 'wasm' };
const urlOf = (from) =>
	new from.StompURL(
		'https://example.com/dir/a.js',
		from.parseConfig(config, 'k').codec,
		'/stomp/',
	);
const SCRIPTS = [
	'/* kept */ x = top.location.href;',
	'parent.postMessage(document.cookie, "*");',
	'function reads(a)  { return a ? top : location }',
];
const js = SCRIPTS.map((script) =>
	plain.modifyJS(script, urlOf(plain), config, 'generic'),
);
const rewritten = () =>
	SCRIPTS.map((script) =>
		thread.modifyJS(script, urlOf(thread), config, 'generic'),
	);
const show = (value) => JSON.stringify(value)?.slice(0, 300);

// A module with the boundary's exports that answers every call with a copy
// of its input and status 0, as the phase 0 artifact did. Assembled here,
// so the check does not depend on an artifact no build ships any more.
function copyingModule() {
	const leb = (value) => {
		const bytes = [];
		do {
			let byte = value & 0x7f;
			value >>>= 7;
			if (value) byte |= 0x80;
			bytes.push(byte);
		} while (value);
		return bytes;
	};
	const text = (string) => [string.length, ...Buffer.from(string)];
	const vector = (items) => [...leb(items.length), ...items.flat()];
	const section = (id, body) => [id, ...leb(body.length), ...body];
	const I32 = 0x7f;
	const type = (params, results) => [
		0x60,
		...vector(params.map((p) => [p])),
		...vector(results.map((r) => [r])),
	];
	const body = (code) => [...leb(code.length + 2), 0, ...code, 0x0b];
	return new Uint8Array([
		...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
		...section(
			1,
			vector([
				type([I32], [I32]),
				type([I32, I32], []),
				type([I32, I32], [I32]),
				type([I32, I32, I32], [I32]),
				type([], [I32]),
			]),
		),
		// e.r, the routing import
		...section(2, vector([[...text('e'), ...text('r'), 0x00, 3]])),
		// a f c r p n b
		...section(3, vector([[0], [1], [2], [3], [4], [4], [4]])),
		...section(5, vector([[0x00, 4]])),
		// where the last input stands and how long it is
		...section(
			6,
			vector([
				[I32, 0x01, 0x41, 0x00, 0x0b],
				[I32, 0x01, 0x41, 0x00, 0x0b],
			]),
		),
		...section(
			7,
			vector([
				[...text('memory'), 0x02, 0],
				...['a', 'f', 'c', 'r', 'p', 'n', 'b'].map((name, i) => [
					...text(name),
					0x00,
					i + 1,
				]),
			]),
		),
		...section(
			10,
			vector([
				// a: every input is written at 64 KiB
				body([0x41, 0x80, 0x80, 0x04]),
				body([]),
				body([0x41, 0x00]),
				// r: the output is the input
				body([0x20, 0x00, 0x24, 0x00, 0x20, 0x01, 0x24, 0x01, 0x41, 0x00]),
				body([0x23, 0x00]),
				body([0x23, 0x01]),
				// b: the routing scratch at 128 KiB
				body([0x41, 0x80, 0x80, 0x08]),
			]),
		),
	]);
}

ok(
	'a thread that holds no module rewrites in JavaScript',
	rewritten().join('\n') === js.join('\n') && !js.includes(SCRIPTS[0]),
	show(js),
);

thread.adoptModule('rewriter', await WebAssembly.compile(copyingModule()));
{
	const answered = thread.rewriterRevision();
	const outputs = rewritten();
	ok(
		'a module that answers every call with its input does not answer the revision',
		answered !== null && answered !== thread.REVISION,
		show(answered),
	);
	ok(
		'and is never asked for a rewrite: its thread rewrites in JavaScript',
		outputs.join('\n') === js.join('\n') &&
			outputs.every((output, i) => output !== SCRIPTS[i]),
		show(outputs),
	);
	// its answer to "is this one expression" would be the question back
	const asked = ['a.b(1)', 'a; b', 'if (a) b'];
	const single = asked.map((code) => thread.singleExpression(code));
	ok(
		'nor for what parses: a javascript: URL of one expression is still one',
		show(single) === show([true, false, false]) &&
			show(single) === show(asked.map((code) => plain.singleExpression(code))),
		show(single),
	);
}

const bytes = readFileSync(`${root}dist/rewriter.wasm`);
thread.adoptModule('rewriter', await WebAssembly.compile(bytes));
{
	const answered = thread.rewriterRevision();
	const recorded = readFileSync(`${root}rust/host/cases.revision`, 'utf8');
	ok(
		"the build's module answers the revision the glue was written against",
		answered === thread.REVISION,
		show({ module: answered, glue: thread.REVISION }),
	);
	ok(
		'which is the revision its outputs are recorded under',
		recorded.split(' ')[0] === thread.REVISION,
		show(recorded),
	);
	const outputs = rewritten();
	ok(
		'and is asked what parses',
		thread.singleExpression('a.b(1)') && !thread.singleExpression('a; b'),
	);
	ok(
		'and is asked: what no rewrite touches comes back as written, the reads go through the access API',
		outputs[0].includes('/* kept */ x = $s$j.get2($s$j.get(top, "top")') &&
			outputs[2].includes('(a)  { return a ? $s$j.get(top, "top") : '),
		show(outputs),
	);
}

// a string a page evaluates may hold a lone surrogate, which has no UTF-8:
// the module would be handed U+FFFD in its place and write that back
{
	const script = '/* kept */ x = "\ud83d".charCodeAt(0) + top.length;';
	const output = thread.modifyJS(script, urlOf(thread), config, 'generic');
	ok(
		"a script with a lone surrogate is the JavaScript rewriter's, and the surrogate is not replaced",
		!script.isWellFormed() &&
			output === plain.modifyJS(script, urlOf(plain), config, 'generic') &&
			!output.includes('\ufffd') &&
			output.includes('.get(top'),
		show(output),
	);
}

await done();
