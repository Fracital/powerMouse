// The wasm rewriter's glue (src/wasm/rewriter.ts) asks a module for a
// rewrite only when the module answers the revision the glue was written
// against, in node. The module is an asset of its own: a host that serves
// an older one beside newer bundles (a cache in front of it, half a deploy)
// hands every thread a module that speaks something else. The wasm core is
// the only rewriter now, so a thread handed such a module, or none at all,
// does not rewrite: the glue returns null and modifyJS hands the script back
// through cannotRewrite (refused with an early error where the browser would
// run it, so it never runs unrewritten). The build's own module answers the
// glue's revision (src/wasm/rewriter.ts REVISION, rust/host/cases.revision).
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
export { printInWasm, REVISION, rewriterRevision } from ${JSON.stringify(`${root}src/wasm/rewriter.ts`)};
export { keepEmbedded, keepSourcesHere, originalSource, sourceKey } from ${JSON.stringify(`${root}src/functionSource.ts`)};
`,
);
const bundle = `${OUT}wasm-rewriter-glue.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
// one thread, handed modules below (and none to begin with)
const thread = await import(`${bundle}?wasm`);

const config = { directory: '/stomp/', codec: 'xor' };
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
// a script the glue does not rewrite is handed back by cannotRewrite: these
// all run in the browser, so they come back ended with an early error no
// browser compiles (UNREWRITTEN_END), not rewritten and not run
const REFUSED = /#STomp_could_not_rewrite_this_script/;
const rewritten = () =>
	SCRIPTS.map((script) =>
		thread.modifyJS(script, urlOf(thread), config, 'generic'),
	);
const show = (value) => JSON.stringify(value)?.slice(0, 300);

// A module with the rewriter member's exports (rust/core-module) that
// answers every call with a copy of its input and status 0, as the phase 0
// artifact did. Assembled here, so the check does not depend on an artifact
// no build ships any more.
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
		// e.j, the rewriter's routing import
		...section(2, vector([[...text('e'), ...text('j'), 0x00, 3]])),
		// a f jc jr jp jn jb
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
				...['a', 'f', 'jc', 'jr', 'jp', 'jn', 'jb'].map((name, i) => [
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
				// jr: the output is the input
				body([0x20, 0x00, 0x24, 0x00, 0x20, 0x01, 0x24, 0x01, 0x41, 0x00]),
				body([0x23, 0x00]),
				body([0x23, 0x01]),
				// jb: the routing scratch at 128 KiB
				body([0x41, 0x80, 0x80, 0x08]),
			]),
		),
	]);
}

{
	const outputs = rewritten();
	ok(
		'a thread that holds no module does not rewrite: it hands the script back refused',
		outputs.every(
			(output) => REFUSED.test(output) && !output.includes('$s$j.get'),
		) && outputs[0].startsWith(SCRIPTS[0]),
		show(outputs),
	);
}

thread.adoptModule('core', await WebAssembly.compile(copyingModule()));
{
	const answered = thread.rewriterRevision();
	const outputs = rewritten();
	ok(
		'a module that answers every call with its input does not answer the revision',
		answered !== null && answered !== thread.REVISION,
		show(answered),
	);
	ok(
		'and is never asked for a rewrite: its thread hands the script back refused, not rewritten',
		outputs.every(
			(output) => REFUSED.test(output) && !output.includes('$s$j.get'),
		),
		show(outputs),
	);
	// nor for what parses: with a module that is not the revision the glue
	// asks nothing of it, so singleExpression has no answer and says no
	const asked = ['a.b(1)', 'a; b', 'if (a) b'];
	const single = asked.map((code) => thread.singleExpression(code));
	ok(
		'nor for what parses: singleExpression says no with a module that is not the revision',
		show(single) === show([false, false, false]),
		show(single),
	);
}

const bytes = readFileSync(`${root}dist/core.wasm`);
thread.adoptModule('core', await WebAssembly.compile(bytes));
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

// A string a page evaluates (eval, new Function, an inline script made
// through the DOM, a string timer) may hold a surrogate with no other half.
// V8 runs such a script wherever the surrogate stands as a character like
// any other, and it has no UTF-8, the only text the module reads: it crosses
// as a stand-in and comes back as itself (src/wasm/rewriter.ts standIns).
// Each place one can stand is run here as the page wrote it and as
// rewritten, by this V8, and the two results are compared unit for unit:
// the values, the text handed to the access API for an error's message, and
// every function's source. Where V8 refuses the script it comes back as it
// was, for the browser to refuse the same way.
{
	const LONE = {
		L: '\ud800',
		M: '\udbff',
		T: '\udc00',
		U: '\udfff',
	};
	// (`<L>` in a source below is the lone surrogate itself, so this file
	// stays well-formed)
	const lone = (text) => text.replace(/<([LMTU])>/g, (_, name) => LONE[name]);
	const units = (text) => {
		const codes = [];
		for (let at = 0; at < text.length; at++)
			codes.push(text.charCodeAt(at).toString(16));
		return codes.join(' ');
	};
	// (a script handed back is warned about)
	const warn = console.warn;
	console.warn = () => {};
	const toString = Function.prototype.toString;
	const TOP = { length: 7 };
	const END = '\n;this.#STomp_could_not_rewrite_this_script;\n';

	/** what `code` answers and hands the access API, every string by its units; functions read back through `from` */
	const run = (code, from) => {
		const partials = [];
		const reads = (o, k, partial) => {
			partials.push(partial);
			return o[k];
		};
		const access = new Proxy(
			{ src: from.keepEmbedded, get: (value) => value, get2: reads },
			{ get: (target, key) => target[key] ?? ((value) => value) },
		);
		const flat = (value) => {
			if (typeof value === 'string') return `string ${units(value)}`;
			if (typeof value === 'function') {
				const native = toString.call(value);
				return `function ${units(from.originalSource(native) ?? native)}`;
			}
			if (value instanceof RegExp)
				return `regexp ${units(value.source)} ${value.flags}`;
			if (Array.isArray(value)) return `[${value.map(flat).join(', ')}]`;
			if (value && typeof value === 'object')
				return `{${Reflect.ownKeys(value)
					.map((key) => `${flat(key)}: ${flat(value[key])}`)
					.join(', ')}}`;
			return `${typeof value} ${String(value)}`;
		};
		try {
			const value = new Function('$s$j', 'top', code)(access, TOP);
			return { value: flat(value), partials };
		} catch (error) {
			return { threw: `${error?.name}: ${units(String(error?.message))}` };
		}
	};

	// a second thread, which keeps the texts itself as the inject does
	// (keepSourcesHere) where the first writes each into its output as the
	// service worker does
	const page = await import(`${bundle}?page`);
	page.adoptModule('core', await WebAssembly.compile(bytes));
	page.keepSourcesHere();
	const THREADS = [
		['the text written into the output', thread],
		['the text kept by the thread', page],
	];

	const every = Array.from({ length: 2048 }, (_, i) =>
		String.fromCharCode(0xdfff - i),
	).join('');
	const RUNS = {
		'a single-quoted string': "return ['a<L>b', top.length];",
		'a double-quoted string': 'return ["<T><L>", top.length];',
		'a string, behind a backslash': 'return ["a\\<L>b", top.length];',
		'a template': 'return [`a<L>${top.length}<T>`];',
		'a template read raw':
			'return [String.raw`<L>\\n<T>${top.length}\\<L>`, top.length];',
		"a tagged template's strings and raw strings":
			'return ((s, v) => [s.join("|"), s.raw.join("|"), v])`x<L>${top.length}\\u{41}<T>`;',
		'a pattern':
			'return [/a<L>+/, /a<L>+/.exec("ba<L><L>c")[0], /<T>|(?:<L>)b/.exec("<L>b")[0], top.length];',
		'a pattern, behind a backslash and behind a lookbehind':
			'return [/\\<L>/.test("<L>"), /(?<=<T>)a/.test("<T>a"), top.length];',
		'a class range between two of them':
			'return [/[<L>-<M>]+/.exec("a\\ud800\\ud900\\udbff\\udc00")[0], /[^<T>-<U>]/.test("\\udc80"), top.length];',
		'a pattern under u':
			'return [/<L>{2}/u.test("<L><L>"), /<L>{2}/u.test("<L>"), /[<L>-<M>]/u.test("\\ud900"), /<T>/u, top.length];',
		'a pattern under v':
			'return [/[<T><L>]/v.test("<L>"), /[[<L>-<U>]--[<T>]]/v.test("<T>"), /[\\q{<L>a}]/v.test("<L>a"), top.length];',
		'a block comment and a line comment':
			'return [function  f ( a ) { /* <L> */ return a // <T>\n }, top.length];',
		'an HTML comment': 'return [top.length, 1]; <!-- <L>\n',
		'a property key':
			'var o = { "<L>": 1, \'<T>k\': 2, ["<M>"]: 3 }; return [o, o["<L>"], o[top.length ? "<T>k" : ""]];',
		'a method named by a string':
			'var o = { "<L>" ( a ) { return a }, get "<T>" ( ) { return 1 } }; return [o["<L>"], Object.getOwnPropertyDescriptor(o, "<T>").get, top.length];',
		'a string in the directive prologue':
			'"<L>"; "use strict"; return [(function () { return this === undefined })(), top.length];',
		'the text of an expression the access API is handed':
			'var o = { "<L>": 5 }, i = 0; return ["<L>x"[i], o["a<L>".slice(1)], o[`<T>${i}`], top.length];',
		'the functions of a script':
			'function  f ( a ) { return "<L>" + a } class C { static "<T>" ( ) { return `<L>` } m ( ) { return /<M>/ } } return [f, C, C["<T>"], C.prototype.m, ( a ) =>  "<U>" + a, f(top.length)];',
		'beside each other and beside a pair':
			'return ["<L><L>", "<L>😀<T>", "<T><T><L>", "😀<L>", top.length];',
		'the last unit of the text': 'return [top.length, "<L>"] //<L>',
		'the second unit of the text and the one before the last':
			'"<L>"; return [top.length, function ( ) { }]; "<T>"',
		'private use characters of its own beside it':
			'return ["<L><T>", function ( ) { return "<M>" }, top.length];',
		'every lone surrogate there is': `return ["${every}", top.length];`,
	};
	for (const [where, written] of Object.entries(RUNS)) {
		const source = lone(written);
		const native = run(source, thread);
		for (const [keeping, from] of THREADS) {
			const output = from.modifyJS(source, urlOf(from), config, 'generic');
			const proxied = run(output, from);
			const marked = /\/\*([0-9a-z]{9})\.[0-9a-z]+\.[0-9a-z]+\*\//.exec(output);
			ok(
				`a lone surrogate in ${where} runs rewritten as it runs natively (${keeping})`,
				!source.isWellFormed() &&
					native.value !== undefined &&
					proxied.value === native.value &&
					// the text of each routed expression is a part of the page's
					proxied.partials.every(
						(partial) =>
							source.includes(partial) || source.includes(partial.slice(1, -1)),
					) &&
					!REFUSED.test(output) &&
					output.includes('$s$j.get(top, "top")') &&
					// nothing of the crossing is left in the output
					output.includes('�') === source.includes('�') &&
					(output.match(/[-]/g) ?? []).join('') ===
						(source.match(/[-]/g) ?? [])
							.join('')
							.repeat(from === thread && marked ? 2 : 1) &&
					// the key its functions are marked with is the page's text's
					(!marked || marked[1] === from.sourceKey(source)),
				show({ native, proxied, output: units(output.slice(0, 400)) }),
			);
		}
	}
	{
		// the text of a routed expression is the page's, quoted
		const source = lone(
			RUNS['the text of an expression the access API is handed'],
		);
		const { partials = [] } = run(
			thread.modifyJS(source, urlOf(thread), config, 'generic'),
			thread,
		);
		const expected = ['("<L>x"[i])', '(o["a<L>".slice(1)])', '(o[`<T>${i}`])']
			.map(lone)
			.map(units);
		ok(
			'the text the access API is handed for an expression holds the lone surrogate as the page wrote it',
			show(partials.map(units)) === show(expected),
			show({ partials: partials.map(units), expected }),
		);
	}

	// where V8 refuses the surrogate the script comes back as it was
	const REFUSES = {
		'in a name': 'var a<L> = 1; return top.length;',
		'where a name starts': 'var <L> = 1; return top.length;',
		'between two tokens': 'var a <L>= 1; return top.length;',
		'as the first unit of the text': '<L>return top.length;',
		'as the last unit of the text, in no comment': 'return top.length;<L>',
		"among a pattern's flags": 'return [/a/g<L>, top.length];',
		"in a group's name": 'return [/(?<a<L>>.)/, top.length];',
		"in a group's name under u": 'return [/(?<a<L>>.)/u, top.length];',
		'behind a backslash in a pattern under u': 'return [/\\<L>/u, top.length];',
		'in a class range that runs down to it':
			'return [/[<M>-<L>]/, top.length];',
		'in a class range that runs down to it, under v':
			'return [/[<U>-<T>]/v, top.length];',
	};
	for (const [where, written] of Object.entries(REFUSES)) {
		const source = lone(written);
		const native = run(source, thread);
		const output = thread.modifyJS(source, urlOf(thread), config, 'generic');
		ok(
			`a lone surrogate ${where} is refused by V8, and the script comes back as it was`,
			!source.isWellFormed() &&
				/^SyntaxError: /.test(native.threw ?? '') &&
				output === source,
			show({ native, output: units(output) }),
		);
	}

	// the order of a lone surrogate and an escape that stands for a
	// surrogate is not the stand-in's (standIns): pinned, to be seen
	{
		const up = lone('return [/[<L>-\\udbff]/.test("\\ud900"), top.length];');
		const down = lone('return [/[\\udfff-<L>]/, top.length];');
		const upOutput = thread.modifyJS(up, urlOf(thread), config, 'generic');
		const downOutput = thread.modifyJS(down, urlOf(thread), config, 'generic');
		const refused = run(down, thread);
		ok(
			'known: a class range from a lone surrogate up to an escaped one runs natively and is handed back refused',
			run(up, thread).value !== undefined && upOutput === up + END,
			show({ native: run(up, thread), output: units(upOutput) }),
		);
		ok(
			"known: a class range from an escaped surrogate down to a lone one is rewritten, and V8 refuses it as it refuses the page's",
			/^SyntaxError: /.test(refused.threw ?? '') &&
				downOutput.includes('$s$j.get(top, "top")') &&
				show(run(downOutput, thread)) === show(refused),
			show({ native: refused, proxied: run(downOutput, thread) }),
		);
	}

	// and so is a module's export name, where V8 refuses a lone surrogate
	// alone (this V8 compiles no module here: the page's half is the
	// browser's to show)
	{
		const source = lone('const a = 1; export { a as "x<L>" }; top;');
		const output = thread.modifyJS(
			source,
			urlOf(thread),
			config,
			'genericModule',
		);
		ok(
			"known: a module's export name that holds a lone surrogate is rewritten, the name as the page wrote it",
			output.includes(lone('export { a as "x<L>" }; $s$j.get(top, "top");')),
			units(output.slice(-80)),
		);
	}

	// a text that leaves fewer private use characters free than it holds
	// different lone surrogates cannot cross
	{
		const all = Array.from({ length: 0xf900 - 0xe000 }, (_, i) =>
			String.fromCharCode(0xe000 + i),
		).join('');
		const rewrite = (text) =>
			thread.modifyJS(text, urlOf(thread), config, 'generic');
		const none = `return ["${all}${LONE.L}", top.length];`;
		const one = `return ["${all.slice(1)}${LONE.L}x${LONE.L}", top.length];`;
		const short = `return ["${all.slice(1)}${LONE.T}${LONE.L}", top.length];`;
		ok(
			'a script that holds every private use character and a lone surrogate is handed back refused',
			rewrite(none) === none + END,
			units(rewrite(none).slice(-80)),
		);
		ok(
			'one that leaves a single one free is rewritten with it',
			!REFUSED.test(rewrite(one)) &&
				rewrite(one).includes('$s$j.get(top, "top")') &&
				run(rewrite(one), thread).value === run(one, thread).value,
			units(rewrite(one).slice(-120)),
		);
		ok(
			'and with two different lone surrogates for the one it is handed back refused',
			rewrite(short) === short + END,
			units(rewrite(short).slice(-80)),
		);
	}

	// what a module imports is routed as the browser reads its specifier: a
	// lone surrogate in a URL is U+FFFD
	{
		const module = (text) =>
			thread.modifyJS(lone(text), urlOf(thread), config, 'genericModule');
		const written =
			'import "./<L>.js"; import x from "./a<T>.js"; top;\n//# sourceMappingURL=<M>.map';
		const output = module(written);
		ok(
			'a lone surrogate in an import specifier and a source map URL routes as U+FFFD does, the rest of the text kept',
			!REFUSED.test(output) &&
				output.includes('$s$j.get(top, "top")') &&
				output === module(written.replace(/<[LMT]>/g, '�')),
			show(output),
		);
	}

	// the parse questions and an error's wording answer for the page's text
	{
		const single = (text) => thread.singleExpression(lone(text));
		const answers = [
			single('"<L>"'),
			single('`<T>` + /<L>/.source'),
			single('/[<L>-<M>]/'),
			single('a<L>'),
			single('"<L>"; 1'),
			single('/[<M>-<L>]/'),
		];
		ok(
			'what parses is answered for the text with its lone surrogates',
			show(answers) === show([true, true, true, false, false, false]),
			show(answers),
		);
		const source = lone('o["<L>x"](1)');
		const printed = thread.printInWasm(source, 'callee')?.printed;
		const native = run(`var o = {}; ${source}`, thread).threw;
		ok(
			"an error's message names an expression with the lone surrogate the page wrote, as V8 does",
			typeof printed === 'string' &&
				native === `TypeError: ${units(`${printed} is not a function`)}`,
			show({ printed: units(printed ?? ''), native }),
		);
	}
	console.warn = warn;
}

await done();
