// Output parity between the wasm expression printer (rust/rwjs/src/printer.rs,
// the `print` member) and the JavaScript one (src/callPrinter.ts), without a
// browser. Both reproduce how V8 names a part of a page's expression in an
// error's message (CallPrinter). The JavaScript one is held to V8 by the
// error-messages suite, so the two agreeing byte for byte holds the wasm one
// to V8 too. Each expression is asked of every part the inject uses
// (src/inject/errorMessages.ts): callee, spread, type, value, key, init.
//
//   node rust/host/printer.mjs [-v] [file...]
//
// With no file the built-in corpus runs; a file adds one expression a line.
// CORE_WASM names another artifact than assets/core.wasm.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const verbose = process.argv.includes('-v');
const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const esbuild = await import('esbuild');
mkdirSync(`${root}test/out/`, { recursive: true });
const out = `${mkdtempSync(`${root}test/out/printer-`)}/`;
const entry = `${out}printer-entry.mjs`;
writeFileSync(
	entry,
	`export { printExpression } from ${JSON.stringify(`${root}src/callPrinter.ts`)};
export { compileModule, CoreInstance } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
`,
);
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: `${out}printer.mjs`,
	logLevel: 'silent',
});
const { printExpression, compileModule, CoreInstance } = await import(
	`${out}printer.mjs?${Date.now()}`
);
rmSync(out, { recursive: true, force: true });

const FLAG_PRINT = 256;
const module = await compileModule(
	readFileSync(process.env.CORE_WASM || `${root}assets/core.wasm`),
);
const instance = new CoreInstance(module, () => -1).members.rewriter;

/** the wasm printer's answer for a part, or null */
function wasm(source, part) {
	const answered = instance.call(`${part}\n${source}`, FLAG_PRINT);
	return 'output' in answered ? answered.output : null;
}

const PARTS = ['callee', 'spread', 'type', 'value', 'key', 'init'];

// expressions covering every branch of the printer: identifiers, this, super,
// members (static/computed/private/optional), calls, new, tagged templates,
// chains, spreads, literals (string/number/bigint/regex with every flag), the
// numeric folding V8's parser does, binary and logical chains, sequences,
// conditionals, unary/update, destructuring assignments, new.target,
// import.meta, templates with and without substitutions.
const CORPUS = [
	'f(a, b)',
	'o.m(a)',
	'o[k](a)',
	'o["m"](a)',
	'o.m(...a)',
	'f(...a, b)',
	'f(a, ...b)',
	'f(...a, ...b)',
	'new C(a)',
	'new o.C()',
	'new C(...a)',
	'a?.b.c',
	'a?.b(c)',
	'a?.[k]',
	'a?.b[c](d)',
	'a.b.c.d',
	'a[b][c]',
	'a.#p',
	'this.#p(x)',
	'tag`x${y}z`',
	'tag.m`x`',
	'import(u)',
	'location',
	'top.location.href',
	'this',
	'this.location',
	'window["top"]',
	'-1',
	'+1',
	'~1',
	'!1',
	'!0',
	'!!1',
	'-!1',
	'1 + 2',
	'1 + 2 + 3',
	'(1 + 2) + 3',
	'1 - 2 * 3',
	'2 ** 3',
	'7 % 3',
	'8 / 4',
	'1 << 4',
	'256 >> 2',
	'-1 >>> 0',
	'5 | 2',
	'6 & 3',
	'5 ^ 1',
	'~~3.7',
	'1e21',
	'0.1',
	'123456789012345680000',
	'1.5e-10',
	'0x10',
	'1n',
	'"a string"',
	'`plain`',
	'`a${b}c`',
	'`${x}${y}`',
	'/foo/gi',
	'/bar/dgimsuy',
	'/baz/',
	'true',
	'false',
	'null',
	'a ? b : c',
	'a, b, c',
	'(a, b, c)',
	'a && b || c',
	'a ?? b',
	'x = y',
	'o.k = y',
	'o[k] = y',
	'x += 1',
	'x++',
	'--o.k',
	'typeof x',
	'void 0',
	'delete o.k',
	'[a, b, , c]',
	'[a, ...b]',
	'({ a, b })',
	'({ a } = v)',
	'({ "k": a } = v)',
	'({ 0: a } = v)',
	'({ [x]: a } = v)',
	'([a, b] = v)',
	'{ a } = v',
	'new.target',
	'import.meta',
	'await x',
	'function () {}',
	'class {}',
	'() => x',
	'super.x',
	'super.m(a)',
	'a instanceof b',
	'a in b',
	'#x in o',
	'#x in o in p',
	'a in b in c',
	'a + b - c',
	'a && b && c',
	'a || b && c',
	'o?.["k"]',
	'f()()',
	'(f())()',
	'a.b().c',
	'x',
	'notParsed +',
	'',
];
for (const file of files)
	for (const line of readFileSync(file, 'utf8').split('\n'))
		if (line.length) CORPUS.push(line);

let mismatches = 0;
let checks = 0;
for (const source of CORPUS) {
	for (const part of PARTS) {
		checks++;
		let js;
		try {
			js = printExpression(source, part);
		} catch (error) {
			js = `THREW ${error}`;
		}
		const w = wasm(source, part);
		if (js !== w) {
			mismatches++;
			console.log(
				`MISMATCH ${JSON.stringify(source)} [${part}]\n  js:   ${JSON.stringify(js)}\n  wasm: ${JSON.stringify(w)}`,
			);
		} else if (verbose && js !== null) {
			console.log(
				`ok ${JSON.stringify(source)} [${part}] = ${JSON.stringify(js)}`,
			);
		}
	}
}
console.log(
	`${checks} checks over ${CORPUS.length} expressions: ${mismatches} mismatches`,
);
process.exit(mismatches ? 1 : 0);
