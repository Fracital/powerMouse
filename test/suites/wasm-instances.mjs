// The instances a thread keeps of a wasm module (src/wasm/thread.ts), in
// node. wasm memory never shrinks, so an instance that ends a call holding
// more than the thread's limit is replaced by a new one from the same
// compiled module, and what the module answers must not depend on which
// instance answered: the same scripts are rewritten with the limit forced
// low (every large script, then every script, costs its instance) and with
// it out of reach, and the outputs compared. A rewrite made during a
// rewrite (a data: module a module imports is rewritten from inside the
// routing call of the one around it; a data: stylesheet a stylesheet
// imports is the same shape) runs in an instance of its own, for both
// modules, and each call keeps its own route.
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
export { modifyCSS } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
`,
);
const bundle = `${OUT}wasm-instances.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const lib = await import(`${bundle}?wasm`);
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

// the core module (the rewriter, the scanner and the suffix lookup in one):
// a call of any member takes an instance of it
const bytes = readFileSync(`${root}dist/core.wasm`);
const rewriter = await WebAssembly.compile(bytes);
const another = await WebAssembly.compile(bytes);
thread.adoptModule('core', rewriter);
/** the thread as it is when it has made no instance of the core yet */
const forget = () => {
	thread.adoptModule('core', another);
	thread.adoptModule('core', rewriter);
};
const warn = console.warn;
console.warn = () => {};

const MB = 1024 * 1024;
const config = { directory: '/stomp/', codec: 'xor' };
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
		const [innerMade, inner] = during(() => next());
		return {
			past,
			innerMade,
			other: inner !== it,
			large: 'output' in large && large.output.includes('/* kept 150 */'),
			after: it.call('abc', 0).output,
			it,
		};
	});
	ok(
		'an instance past the limit goes on answering its own call',
		inside.past > 2 * MB &&
			inside.large &&
			inside.after === 'abc' &&
			inside.other,
		show({ ...inside, it: undefined }),
	);
	ok('and is dropped once the call returned', next() !== inside.it);
	thread.setMemoryLimit(thread.PAGE_MEMORY_LIMIT);
}

// a call made during a call
{
	forget();
	// flag 1 asks the module to route its input through the host (the
	// boundary's own check, test/suites/wasm-artifact.mjs)
	const [nestedMade, nested] = during(() =>
		thread.withInstance(
			'rewriter',
			(outer) => {
				const first = outer.call('u', 1).output;
				const second = outer.call('w', 1).output;
				return { outer, first, second };
			},
			(kind, text) =>
				text === 'u'
					? `outer:${thread.withInstance(
							'rewriter',
							(inner) => inner.call('v', 1).output,
							(kind, text) => `inner:${text}`,
						)}`
					: `outer:${text}`,
		),
	);
	ok(
		'a call made from inside a routing call is answered, by an instance of its own',
		nested.first === 'outer:inner:v' && nestedMade === 2,
		show({ first: nested.first, made: nestedMade }),
	);
	ok(
		'and the route of the call around it goes on answering that call',
		nested.second === 'outer:w',
		show(nested.second),
	);
	const pair = () =>
		thread.withInstance('rewriter', (outer) => [outer, next()]);
	const [againMade, again] = during(pair);
	ok(
		'both instances are kept: the same two serve the next call and the call inside it',
		againMade === 0 &&
			again[0] === nested.outer &&
			again[1] instanceof BufferInstance &&
			again[1] !== again[0] &&
			pair()[1] === again[1],
		`${againMade} made`,
	);
	const thrown = thread.withInstance('rewriter', (outer) => [
		thread.withInstance('rewriter', () => {
			throw new Error('trap');
		}),
		outer.call('abc', 0).output,
	]);
	const afterThrow = pair();
	ok(
		'a call that throws inside another declines itself alone and costs its own instance',
		show(thrown) === show([null, 'abc']) &&
			afterThrow[0] === again[0] &&
			afterThrow[1] !== again[1],
		show(thrown),
	);
	thread.setMemoryLimit(2 * MB);
	const innerLarge = thread.withInstance('rewriter', (outer) => [
		outer,
		thread.withInstance('rewriter', (inner) => {
			inner.call(sized(150), 0);
			return inner;
		}),
	]);
	const afterInner = pair();
	ok(
		'an inner instance past the limit is dropped, the outer one kept',
		innerLarge[1].memoryBytes > 2 * MB &&
			afterInner[0] === innerLarge[0] &&
			afterInner[1] !== innerLarge[1],
	);
	const outerLarge = thread.withInstance('rewriter', (outer) => {
		outer.call(sized(150), 0);
		return [outer, next()];
	});
	ok(
		'an outer instance past the limit is dropped, the inner one kept for the next call',
		outerLarge[0].memoryBytes > 2 * MB && next() === outerLarge[1],
	);
	thread.setMemoryLimit(thread.PAGE_MEMORY_LIMIT);

	// one inside another, deeper than the thread goes
	const nest = (levels) =>
		thread.withInstance('rewriter', (it) => [
			it,
			...(levels > 1 ? (nest(levels - 1) ?? [null]) : []),
		]);
	const [deepMade, deep] = during(() => nest(thread.INSTANCES + 2));
	ok(
		'a thread runs INSTANCES of a module at a time; a call deeper than that is declined and the ones around it go on',
		thread.INSTANCES === 4 &&
			deep.length === thread.INSTANCES + 1 &&
			deep.at(-1) === null &&
			new Set(deep).size === deep.length &&
			deep.slice(0, -1).every((it) => it instanceof BufferInstance) &&
			deepMade === thread.INSTANCES - 1,
		`${deep.length} levels, ${deepMade} made`,
	);
	const [keptMade] = during(() => nest(thread.INSTANCES));
	ok('and keeps them', keptMade === 0, `${keptMade} made`);

	// a module replaced while an instance of the old one is in a call
	const replaced = thread.withInstance('rewriter', (it) => {
		thread.adoptModule('core', another);
		return [it, it.call('abc', 0).output, next()];
	});
	ok(
		'an instance whose module was replaced during its call finishes the call and is not kept',
		replaced[1] === 'abc' &&
			replaced[2] !== replaced[0] &&
			next() === replaced[2],
	);
	thread.adoptModule('core', rewriter);
}

// the scanner: a data: stylesheet a stylesheet imports is rewritten from
// inside the routing call of the sheet around it (routeCSS)
{
	const scanner = await WebAssembly.compile(bytes);
	// the thread as it is when it has made no instance of the core yet
	thread.adoptModule('core', scanner);
	const pageOf = (from) =>
		new from.StompURL(
			'https://example.com/dir/a.css',
			from.parseConfig(config, 'k').codec,
			'/stomp/',
		);
	const styles = (sheet) => {
		const told = {};
		return [lib.modifyCSS(sheet, pageOf(lib), 'stylesheet', told), told.by];
	};
	const sheet =
		'@import url("data:text/css,a%7Bb:url(c)%7D"); @import "data:text/css;base64,YXtiOnVybChjKX0="; a { background: url(x.png) }';
	const [sheetMade, [output, by]] = during(() => styles(sheet));
	ok(
		"a data: stylesheet a stylesheet imports is the module's rewrite, as the sheet around it is",
		by === 'wasm' && output !== sheet,
		show({ by, output }),
	);
	ok(
		'by an instance of its own: two were made, one for the sheet and one for both sheets inside it',
		sheetMade === 2,
		`${sheetMade} made`,
	);
	const [againMade, [again]] = during(() => styles(sheet));
	ok(
		'and the thread keeps both for the next sheet',
		againMade === 0 && again === output,
		`${againMade} made`,
	);
	// the route of the sheet around it goes on answering after the sheet
	// inside returned: the url() after the import resolves against the
	// outer sheet's own URL (read out of the route: it is sealed)
	const codec = lib.parseConfig(config, 'k').codec;
	ok(
		"the outer sheet's route answers what follows the import",
		[...output.matchAll(/\/stomp\/binary\/([\w-]+)/g)].some(
			([, sealed]) => codec.decode(sealed) === 'https://example.com/dir/x.png',
		),
		show(output),
	);
	// one data: stylesheet inside another, deeper than the thread runs
	// instances: the outer sheets are the module's (each data: import routed
	// in an instance of its own), and the innermost routeCSS call, finding no
	// free instance, is the regex fallback's (src/cssURLs.ts); so the sheet
	// is rewritten to its full depth, every level's url() sealed into the one
	// above it. The outermost level's own url() shows as a routed URL; the
	// rest are sealed inside the data: imports.
	const wrap = (text, level) =>
		`@import url("data:text/css,${encodeURIComponent(text)}"); .level${level} { background: url(l${level}.png) }`;
	let nested = '.level0 { background: url(l0.png) }';
	for (let level = 1; level <= thread.INSTANCES; level++)
		nested = wrap(nested, level);
	const [nestedMade, [deep, deepBy]] = during(() => styles(nested));
	const codecCSS = lib.parseConfig(config, 'k').codec;
	const outerRouted = [...deep.matchAll(/\/stomp\/binary\/([\w-]+)/g)].some(
		([, sealed]) =>
			codecCSS.decode(sealed).endsWith(`/l${thread.INSTANCES}.png`),
	);
	ok(
		'stylesheets nested deeper than INSTANCES are rewritten to their depth (the innermost by the regex fallback)',
		deepBy === 'wasm' &&
			deep !== nested &&
			outerRouted &&
			nestedMade === thread.INSTANCES - 2,
		show({ deepBy, nestedMade, outerRouted }),
	);
}

// the rewriter's glue: a data: module a module imports
{
	const script =
		'import d from "data:text/javascript,/* kept inner */ export default top.location.href;";\n' +
		'import "./b.js";\n' +
		'/* kept outer */ export const x = top;\n';
	next();
	thread.withInstance('rewriter', () => next());
	const [glueMade, output] = during(() => rewrite(script, 'genericModule'));
	const specifier = /import ['"](\/stomp\/[^'"]+)['"]/;
	const inner = decodeURIComponent(
		/from "data:text\/javascript,([^"]*)"/.exec(output)?.[1] ?? '',
	);
	ok(
		"a data: module a module imports is the module's rewrite, as the module around it is",
		output.includes('/* kept outer */ export const x = $s$j.get(top, "top")') &&
			inner.includes(
				'/* kept inner */ export default $s$j.get2($s$j.get(top, "top")',
			),
		show(output),
	);
	ok(
		'the import after it is routed through the proxy',
		/^\/stomp\/\S+$/.test(specifier.exec(output)?.[1] ?? ''),
		show(specifier.exec(output)?.[1]),
	);
	ok(
		'by the two instances the thread keeps',
		glueMade === 0,
		`${glueMade} made`,
	);
	// one data: module inside another, deeper than the thread runs instances:
	// the outer modules are the module's rewrite (its comment kept), and the
	// innermost, finding no free instance, is declined. A wasm-only build has
	// no JavaScript rewriter to take it, so cannotRewrite hands it back as the
	// page wrote it (its comment kept, but nothing rewritten); being a module
	// the browser runs, it carries an end no browser compiles so it cannot run
	// unrewritten.
	const wrap = (text, level) =>
		`import v from "data:text/javascript,${encodeURIComponent(text)}"; /* level ${level} */ export default v + top.length;`;
	let nested = '/* level 0 */ export default top.length;';
	for (let level = 1; level <= thread.INSTANCES; level++)
		nested = wrap(nested, level);
	let text = rewrite(nested, 'genericModule');
	const levels = [];
	for (let level = thread.INSTANCES; level >= 0; level--) {
		levels.push([
			level,
			text.includes(`/* level ${level} */`),
			text.includes('$s$j.get(top, "top")') ||
				text.includes("$s$j.get(top, 'top')"),
		]);
		text = decodeURIComponent(
			/from "data:text\/javascript,([^"]*)"/.exec(text)?.[1] ?? '',
		);
	}
	ok(
		'modules nested deeper than INSTANCES are rewritten to their depth, the innermost handed back as written (its comment kept, nothing rewritten)',
		levels.every(([level, kept, rewritten]) => kept && rewritten === level > 0),
		show(levels),
	);
}

console.warn = warn;
await done();
