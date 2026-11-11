// The instance a thread keeps of a wasm module (src/wasm/thread.ts), in
// node. wasm memory never shrinks, so an instance that ends a call holding
// more than the thread's limit is replaced by a new one from the same
// compiled module, and what the module answers must not depend on which
// instance answered: the same scripts are rewritten with the limit forced
// low (every large script, then every script, costs its instance) and with
// it out of reach, and the outputs compared.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP wasm-instances: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}wasm-instances-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyJS } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { BufferInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
export * as thread from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
`,
);
const bundle = `${OUT}wasm-instances.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['css-tree'],
	outfile: bundle,
	logLevel: 'silent',
});
const lib = await import(bundle);
const { thread, BufferInstance } = lib;

// every instance any thread here makes
let made = 0;
const Native = WebAssembly.Instance;
WebAssembly.Instance = class extends Native {
	constructor(...given) {
		super(...given);
		made++;
	}
};
const during = (work) => {
	const before = made;
	const result = work();
	return [made - before, result];
};

const bytes = readFileSync(`${root}dist/rewriter.wasm`);
const rewriter = await WebAssembly.compile(bytes);
const another = await WebAssembly.compile(bytes);
thread.adoptModule('rewriter', rewriter);
/** the thread as it is when it has made no instance of the rewriter yet */
const forget = () => {
	thread.adoptModule('rewriter', another);
	thread.adoptModule('rewriter', rewriter);
};
const warn = console.warn;
console.warn = () => {};

const MB = 1024 * 1024;
const config = { directory: '/stomp/', codec: 'xor', rewriter: 'wasm' };
const urlOf = (from) =>
	new from.StompURL(
		'https://example.com/dir/a.js',
		from.parseConfig(config, 'k').codec,
		'/stomp/',
	);
const rewrite = (script, type = 'generic') =>
	lib.modifyJS(script, urlOf(lib), config, type);
/** a script of about `kb` KB whose every statement is rewritten */
const sized = (kb) =>
	`/* kept ${kb} */\n${'x = top.location.href + y;\n'.repeat(Math.round((kb * 1024) / 27))}`;
/** the instance the next call of `name` gets */
const next = (name = 'rewriter') => thread.withInstance(name, (it) => it);
const show = (value) => JSON.stringify(value)?.slice(0, 400);

// the limit a thread has when nobody raised it is the page's
{
	ok(
		"a page's instance keeps less than a serving thread's",
		thread.PAGE_MEMORY_LIMIT === 8 * MB &&
			thread.SERVING_MEMORY_LIMIT === 64 * MB,
	);
	const first = next();
	const small = rewrite(sized(100));
	const held = first.memoryBytes;
	ok(
		'a script that leaves the instance under the limit keeps it',
		next() === first && held > 2 * MB && held <= thread.PAGE_MEMORY_LIMIT,
		`${held} bytes`,
	);
	const large = rewrite(sized(400));
	const grown = first.memoryBytes;
	ok(
		'the instance rewrites a script that takes it past the limit',
		grown > thread.PAGE_MEMORY_LIMIT &&
			large.includes('/* kept 400 */') &&
			large.includes('$s$j.get(top, "top")'),
		`${grown} bytes`,
	);
	const second = next();
	ok(
		'and is not kept: the next call has a new one, of the size a new one has',
		second instanceof BufferInstance &&
			second !== first &&
			second.memoryBytes < 2 * MB,
		`${second.memoryBytes} bytes`,
	);
	ok(
		'which answers what the first answered',
		rewrite(sized(100)) === small && rewrite(sized(400)) === large,
	);
	thread.setMemoryLimit(thread.SERVING_MEMORY_LIMIT);
	const serving = next();
	rewrite(sized(400));
	ok(
		'a serving thread keeps the instance that script grew',
		next() === serving && serving.memoryBytes > thread.PAGE_MEMORY_LIMIT,
		`${serving.memoryBytes} bytes`,
	);
}

// what the worker-rewrites fixture evaluates as its large function, in a
// worker and in the page, is past what their threads keep
{
	const scope = {};
	new Function(
		'self',
		readFileSync(`${root}test/pages/worker-rewrites-large.js`, 'utf8'),
	)(scope);
	const body = scope.largeScript();
	thread.setMemoryLimit(thread.PAGE_MEMORY_LIMIT);
	forget();
	const before = next();
	const output = rewrite(`function anonymous(a\n) {\n${body}\n}`);
	ok(
		"the worker-rewrites fixture's large function costs a page's thread its instance",
		output.includes('/* kept */') &&
			before.memoryBytes > thread.PAGE_MEMORY_LIMIT &&
			next() !== before,
		`${body.length} characters, ${before.memoryBytes} bytes`,
	);
}

// the same rewrites whichever instance makes them
{
	const scripts = [
		'/* kept */ x = top.location.href;',
		sized(60),
		'function reads(a)  { return a ? top : location }',
		'import d from "./d.js"; export default top;',
		sized(150),
		'parent.postMessage(document.cookie, "*");',
		sized(60),
		'eval("location.href"); new Function("return top")();',
	];
	const run = () =>
		scripts.map((script) =>
			rewrite(
				script,
				script.startsWith('import') ? 'genericModule' : 'generic',
			),
		);
	thread.setMemoryLimit(thread.SERVING_MEMORY_LIMIT);
	run();
	const [keptMade, kept] = during(run);
	ok(
		'out of reach of the limit, one instance makes every rewrite',
		keptMade === 0 && kept.every((output, i) => output !== scripts[i]),
		`${keptMade} made`,
	);
	thread.setMemoryLimit(2 * MB);
	forget();
	next();
	const [lowMade, low] = during(run);
	ok(
		'with the limit forced low every large script costs its instance',
		lowMade === 3,
		`${lowMade} made`,
	);
	ok(
		'and the rewrites are the same across every reset',
		show(low) === show(kept) && low.join('\n') === kept.join('\n'),
	);
	thread.setMemoryLimit(0);
	forget();
	const [noneMade, none] = during(run);
	ok(
		'with no instance kept at all they are the same again',
		noneMade === scripts.length && none.join('\n') === kept.join('\n'),
		`${noneMade} made`,
	);
	thread.setMemoryLimit(2 * MB);
	// the instance is replaced after its call, never during it
	const inside = thread.withInstance('rewriter', (it) => {
		const large = it.call(sized(150), 0);
		const past = it.memoryBytes;
		return {
			past,
			large: 'output' in large && large.output.includes('/* kept 150 */'),
			after: it.call('abc', 0).output,
			it,
		};
	});
	ok(
		'an instance past the limit goes on answering its own call',
		inside.past > 2 * MB && inside.large && inside.after === 'abc',
		show({ ...inside, it: undefined }),
	);
	ok('and is dropped once the call returned', next() !== inside.it);
	thread.setMemoryLimit(thread.PAGE_MEMORY_LIMIT);
}

console.warn = warn;
await done();
