// The early-error cases (rust/host/early-errors.txt) and V8's verdict on a
// text, for rust/host/early.mjs and the suites that hold the rewriters to
// them (rewriter-unit, early-errors).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CASES = fileURLToPath(
	new URL('./early-errors.txt', import.meta.url),
);
export const KNOWN = fileURLToPath(
	new URL('./early-known.txt', import.meta.url),
);

/**
 * Texts the node that runs this answers otherwise than the Chrome the
 * suites run in, and why: the file records Chrome's verdict for them, which
 * the early-errors suite holds, and node's is not held to it
 */
export const NODE_DIFFERS = new Map([
	[
		'/(?<n>a)(?:b|(?<n>c))/',
		'V8 13.6 (node 24) takes a group name twice where both groups can match; Chrome 152 refuses it, as the specification does',
	],
]);

const TOKENS = { NL: '\n', CR: '\r', LS: ' ', PS: ' ' };

/** a case's text with its `<NL>`, `<U+XXXX>` and the like spelled out */
export const spelled = (text) =>
	text.replace(/<(NL|CR|LS|PS|U\+([0-9A-F]{4,6}))>/g, (_, name, hex) =>
		hex ? String.fromCodePoint(parseInt(hex, 16)) : TOKENS[name],
	);

/**
 * The lines of the file: `{ line, text, code, recorded }` for a case
 * (`recorded` the three marks, `?` where none is yet), `{ line, raw }` for a
 * comment or an empty line
 */
export function readCases(file = CASES) {
	return readFileSync(file, 'utf8')
		.split('\n')
		.map((raw, index) => {
			const found = /^([-+?]{3}) (.*)$/.exec(raw);
			if (!found || raw.startsWith('#')) return { line: index + 1, raw };
			const text = found[2].trimEnd();
			return {
				line: index + 1,
				raw,
				text,
				code: spelled(text),
				recorded: found[1],
			};
		});
}

/** rust/host/early-known.txt: each text it names, and as what */
export function readKnown(file = KNOWN) {
	const known = new Map();
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		const found = /^([a-z]+) (.*)$/.exec(raw);
		if (found && !raw.startsWith('#')) known.set(found[2].trimEnd(), found[1]);
	}
	return known;
}

/** what a text is run inside, besides as it is: every one a classic script */
export const WRAPPERS = {
	function: (code) => `function w() {\n${code}\n}`,
	arrow: (code) => `(() => {\n${code}\n});`,
	async: (code) => `async function w() {\n${code}\n}`,
	generator: (code) => `function* w() {\n${code}\n}`,
	method: (code) => `class W { m() {\n${code}\n} }`,
	static: (code) => `class W { static {\n${code}\n} }`,
	block: (code) => `{\n${code}\n}`,
};

export const STRICT = "'use strict';\n";

/**
 * Every script a case stands for: the three the file records a verdict of
 * (`recorded`: `+`, `-` or `?`), and with `wide` the text inside each of
 * WRAPPERS as a script and as a module
 */
export function variants(entry, wide = false) {
	const { code, recorded, line, text } = entry;
	const out = [
		{ name: 'script', code, module: false, recorded: recorded[0] },
		{
			name: 'strict',
			code: STRICT + code,
			module: false,
			recorded: recorded[1],
		},
		{ name: 'module', code, module: true, recorded: recorded[2] },
	];
	if (wide)
		for (const [name, wrap] of Object.entries(WRAPPERS))
			for (const module of [false, true])
				out.push({
					name: `${name}${module ? ' (module)' : ''}`,
					code: wrap(code),
					module,
				});
	for (const variant of out) Object.assign(variant, { line, text });
	return out;
}

/**
 * Whether Chrome's verdict on a text is V8's when it parses every function
 * in full at once (`eager` on a script for `v8Verdicts`): one with a `\\u`
 * escape. The preparser of V8 13.7 and before (node 24's, Chrome 137's),
 * which reads a function V8 compiles lazily, takes `eval` and `arguments`
 * written with an escape where strict code refuses the names; V8 13.8
 * (Chrome 138) refuses them there as its full parse does. The file records
 * Chrome's verdict, and node's lazy one is what rust/host/early.mjs holds
 * the module to otherwise: a browser that old must not have a script it
 * takes answered as one no browser runs
 */
export const eager = (text) => text.includes('\\u');

/**
 * V8's verdict on each `{ code, module, eager }` without running any: null
 * when it compiles, the error's name and message when not
 * (rust/host/v8-verdicts.mjs in a node of its own, since compiling a module
 * needs a flag; `--no-lazy` for the `eager` ones)
 */
export function v8Verdicts(scripts) {
	const verdicts = new Array(scripts.length);
	for (const full of [false, true]) {
		const at = [];
		scripts.forEach((script, index) => {
			if (!!script.eager === full) at.push(index);
		});
		if (!at.length) continue;
		const child = spawnSync(
			process.execPath,
			[
				'--experimental-vm-modules',
				'--no-warnings',
				...(full ? ['--no-lazy'] : []),
				fileURLToPath(new URL('./v8-verdicts.mjs', import.meta.url)),
			],
			{
				input: JSON.stringify(
					at.map((index) => ({
						code: scripts[index].code,
						module: !!scripts[index].module,
					})),
				),
				maxBuffer: 1 << 30,
				encoding: 'utf8',
			},
		);
		if (child.status !== 0)
			throw new Error(`v8-verdicts.mjs failed: ${child.stderr}`);
		JSON.parse(child.stdout).forEach(
			(verdict, index) => (verdicts[at[index]] = verdict),
		);
	}
	return verdicts;
}

/**
 * The first line of early-errors.txt's last section: the strict-mode early
 * errors, generated (`strictTexts`). `node rust/host/early.mjs --record`
 * writes the section anew below its comment from what `strictTexts` gives,
 * less what the file has above it
 */
export const GENERATED = '# 11.2.2 Strict mode code, generated:';

/** names strict code refuses as an identifier, and the ones near them */
const STRICT_NAMES = [
	'eval',
	'arguments',
	'implements',
	'package',
	'static',
	'let',
	'yield',
	'await',
	// with an escape: V8's full parse reads these as the names they spell,
	// and its preparser (a function compiled lazily) the first two not
	'\\u0065val',
	'argument\\u0073',
	'impl\\u0065ments',
	'st\\u0061tic',
	'l\\u0065t',
	'yi\\u0065ld',
	'aw\\u0061it',
];

/** where a name `X` stands: bound, assigned, read, labelled, in the places that make code strict */
const STRICT_PLACES = [
	'var X',
	'let X',
	'const X = 1',
	'function X() {}',
	'function* X() {}',
	'async function X() {}',
	'(function X() {})',
	'function f(X) {}',
	'function f(...X) {}',
	'function f(X = 1) {}',
	'function f({ X }) {}',
	'function f([X]) {}',
	'function f({ a: X }) {}',
	'(X) => 1',
	'X => 1',
	'async X => 1',
	'async (X) => 1',
	'try {} catch (X) {}',
	'try {} catch ({ X }) {}',
	'X: ;',
	'X = 1',
	'X++',
	'--X',
	'X += 1',
	'X ||= 1',
	'[X] = a',
	'[...X] = a',
	'({ X } = a)',
	'({ X = 1 } = a)',
	'({ a: X } = a)',
	'for (X in a);',
	'for (X of a);',
	'for (var X in a);',
	'for (let X of a);',
	'X',
	'typeof X',
	'({ X })',
	'({ m(X) {} })',
	'({ set m(X) {} })',
	'function X() { "use strict" }',
	'function f(X) { "use strict" }',
	'(function X() { "use strict" })',
	'(X) => { "use strict" }',
	'X => { "use strict" }',
	'function f() { "use strict"; var X }',
	'function f() { "use strict"; X = 1 }',
	'class X {}',
	'(class X {})',
	'class A { m(X) {} }',
	'class A { static m(X) {} }',
	'class A { set m(X) {} }',
	'class A { m() { var X } }',
	'class A { m() { X = 1 } }',
	'class A { m() { X } }',
	'class A { [X]() {} }',
	'class A { [X = 1]() {} }',
	'class A { a = X }',
	'class A { static { var X } }',
	'class A extends (X = 1) {}',
	'class A extends X {}',
	'class A { constructor(X) {} }',
	'({ m() { "use strict"; var X } })',
];

/** the other strict-mode early errors, each in the places that make code strict, with neighbours sloppy code takes */
const STRICT_OTHERS = [
	// legacy octal and non-octal decimal integer literals
	'01',
	'08',
	'09.5',
	'00',
	'07.5',
	'0_1',
	'01n',
	'09e1',
	'x = 01 + 1',
	'({ 01: 1 })',
	'({ get 01() {} })',
	'class A { 01() {} }',
	'class A { 01 = 1 }',
	'class A { [01]() {} }',
	'class A { m() { 01 } }',
	'class A { static { 01 } }',
	'class A extends (01, B) {}',
	'class A { a = 08 }',
	'function f() { "use strict"; 01 }',
	'function f() { "use strict" } 01',
	'class A {} 01',
	'(class {}, 01)',
	'01..toString()',
	// legacy octal escapes, `\8` and `\9`
	"'\\01'",
	"'\\1'",
	"'\\7'",
	"'\\8'",
	"'\\9'",
	"'\\0'",
	"'\\00'",
	"'\\08'",
	"'\\09'",
	"'\\0a'",
	"'\\377'",
	"'\\400'",
	"'a\\1b'",
	"'\\\\1'",
	"'\\x01'",
	"'\\u0001'",
	"({ '\\01': 1 })",
	"class A { '\\01'() {} }",
	"class A { ['\\01']() {} }",
	"class A { m() { '\\01' } }",
	"class A { a = '\\8' }",
	"'\\01'; 'use strict'",
	"'use strict'; '\\01'",
	"'\\8'; 'use strict'",
	"function f() { '\\01'; 'use strict' }",
	"function f() { 'a'; '\\01'; 'use strict' }",
	"function f() { 'use strict'; '\\01' }",
	"function f() { 'use strict' } '\\01'",
	"function f() { '\\01' } 'use strict'",
	"() => { '\\01'; 'use strict' }",
	"({ m() { '\\8'; 'use strict' } })",
	"'\\01'<NL>'use strict'",
	"'\\01'<NL>;'use strict'",
	"'\\01' + 1; 'use strict'",
	'`\\01`',
	'a`\\01`',
	"'\\<NL>01'",
	// with
	'with (a) {}',
	'class A { m() { with (a) {} } }',
	'class A { static { with (a) {} } }',
	'class A { [function () { with (a) {} }]() {} }',
	'function f() { "use strict"; with (a) {} }',
	'function f() { "use strict" } with (a) {}',
	'function f() { with (a) {} "use strict" }',
	'function f() { with (a) {} } "use strict"',
	'({ m() { "use strict"; with (a) {} } })',
	'() => { "use strict"; with (a) {} }',
	'class A {} with (a) {}',
	// delete of a name
	'delete x',
	'delete (x)',
	'delete ((x))',
	'delete (x, y)',
	'delete x.y',
	'delete this',
	'delete eval',
	'delete (1, x)',
	'delete x?.y',
	'delete void x',
	'delete (x = 1)',
	'class A { m() { delete x } }',
	'class A { [delete x]() {} }',
	'class A { a = delete x }',
	'function f() { "use strict"; delete x }',
	'function f() { "use strict" } delete x',
	// a parameter's name twice
	'function f(a, a) {}',
	'function f(a, b, a) {}',
	'function f(a, ...a) {}',
	'function f(a, a) { "use strict" }',
	'(function (a, a) { "use strict" })',
	'function* f(a, a) {}',
	'async function f(a, a) {}',
	'({ m(a, a) {} })',
	'({ set m(a, a) {} })',
	'class A { m(a, a) {} }',
	'class A { m() { function f(a, a) {} } }',
	'class A { static { (function (a, a) {}) } }',
	'class A extends (function (a, a) {}) {}',
	'function f(a, a) {} function g() { "use strict" }',
	'function f(a, a) { function g() { "use strict" } }',
	'function f(a, [a]) {}',
	'function f(a = 1, a) {}',
	// use strict after parameters that are not simple
	'function f(a = 1) { "use strict" }',
	'function f({ a }) { "use strict" }',
	'function f(...a) { "use strict" }',
	'(a = 1) => { "use strict" }',
	'({ m(a = 1) { "use strict" } })',
	'class A { m(a = 1) { "use strict" } }',
	'function f(a = 1) { "a"; "use strict" }',
	'function f(a = 1) { "use\\u0020strict" }',
	'function f(a = 1) { ("use strict") }',
	'function f(a = 1) { x; "use strict" }',
	// a function declared as a statement
	'if (a) function f() {}',
	'if (a) function f() {} else ;',
	'l: function f() {}',
	'l: l2: function f() {}',
	'{ function f() {} function f() {} }',
	'switch (a) { case 1: function f() {} case 2: function f() {} }',
	'class A { m() { if (a) function f() {} } }',
	'class A { m() { l: function f() {} } }',
	'class A { m() { { function f() {} function f() {} } } }',
	'function f() { "use strict"; { function g() {} function g() {} } }',
	'function f() { "use strict"; l: function g() {} }',
	'{ async function f() {} async function f() {} }',
	'{ function f() {} async function f() {} }',
	// directives that are not the use strict one
	"'use\\u0020strict'; with (a) {}",
	"('use strict'); with (a) {}",
	"'use strict' + 1; with (a) {}",
	"a; 'use strict'; with (a) {}",
	"'use strict'<NL>+ 1; with (a) {}",
	"'use strict'<NL>(a); with (a) {}",
	"'use strict'<NL>[0]; with (a) {}",
	"'use strict'.x; with (a) {}",
	"'use strict'`x`; with (a) {}",
	"'use strict', 1; with (a) {}",
	"'use strict' in a; with (a) {}",
	// arguments in a field's initializer and a static block
	'class A { a = arguments }',
	'class A { a = () => arguments }',
	'class A { a = function () { arguments } }',
	'class A { static { arguments } }',
	'class A { static { () => arguments } }',
	'class A { [arguments]() {} }',
	'class A { a = typeof arguments }',
	'class A { a = { arguments } }',
	// the names as property names, which they may be
	'a.eval = 1',
	'arguments[0] = 1',
	'({ eval() {} })',
	'class A { arguments() {} }',
	'class A { static eval() {} }',
	'class A { implements() {} }',
	'class A { #eval }',
	'({ implements: 1 })',
	// let and yield where sloppy code reads them as names
	'let = 1',
	'let.a = 1',
	'for (let in a);',
	'for (let.a in b);',
	'let<NL>a = 1',
	'if (a) let<NL>b = 1',
	'yield<NL>a',
	'var { let } = a',
	'var [let] = a',
	'function f() { "use strict"; let }',
	'function yield() { "use strict" }',
	'function f(yield) { "use strict" }',
	'function let() { "use strict" }',
	// let in a catch clause's pattern, which V8 refuses as it does in a
	// lexical declaration's
	'try {} catch ([let]) {}',
	'try {} catch ({ a: let }) {}',
	'try {} catch ([...let]) {}',
	'try {} catch ({ ...let }) {}',
	'try {} catch ({ let = 1 }) {}',
	'try {} catch ([[let]]) {}',
	'try {} catch ({ let: a }) {}',
	'try {} catch ([l\\u0065t]) {}',
	// an escaped eval where V8 may compile lazily, or does not
	'x => { var \\u0065val }',
	'(x => { var \\u0065val })',
	'x => \\u0065val = 1',
	'x => { argument\\u0073 = 1 }',
	'(function () { var \\u0065val })',
	'(function () { var \\u0065val })()',
	'!function () { var \\u0065val }()',
	'(function (\\u0065val) {})',
	'(function () { "use strict"; var \\u0065val })',
	'function f() { return x => { var \\u0065val } }',
	'function f(a = \\u0065val = 1) {}',
	'function f(a = () => { var \\u0065val }) {}',
	'async function f() { var \\u0065val }',
	'function* g() { var \\u0065val }',
	'(async () => { var \\u0065val })',
	'({ get a() { \\u0065val = 1 } })',
	'class A { a = () => argument\\u0073 }',
	'class A { a = () => { argument\\u0073 } }',
	'class A { static { () => { var \\u0065val } } }',
	'class A { static { \\u0065val = 1 } }',
	'class A { static a = \\u0065val = 1 }',
	'class A { [() => { var \\u0065val }]() {} }',
	'class A extends (() => { var \\u0065val }) {}',
	'class A { m() { class \\u0065val {} } }',
	'class A { m() { (function \\u0065val() {}) } }',
	'function f() {} var \\u0065val',
	'function f() { "use strict" } var \\u0065val',
	'\\u0065val(1)',
	'a.\\u0065val = 1',
	'({ \\u0065val: 1 })',
	'class A { \\u0065val() {} }',
	'import \\u0065val from "a"',
	'import { a as \\u0065val } from "a"',
	'export function \\u0065val() {}',
];

/** the generated section's texts: each place with each name, then the others */
export function strictTexts() {
	const texts = new Set();
	for (const place of STRICT_PLACES)
		for (const name of STRICT_NAMES) texts.add(place.replaceAll('X', name));
	for (const text of STRICT_OTHERS) texts.add(text);
	return [...texts];
}
