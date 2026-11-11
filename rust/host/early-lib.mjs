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
 * V8's verdict on each `{ code, module }` without running any: null when it
 * compiles, the error's name and message when not (rust/host/v8-verdicts.mjs
 * in a node of its own, since compiling a module needs a flag)
 */
export function v8Verdicts(scripts) {
	const child = spawnSync(
		process.execPath,
		[
			'--experimental-vm-modules',
			'--no-warnings',
			fileURLToPath(new URL('./v8-verdicts.mjs', import.meta.url)),
		],
		{
			input: JSON.stringify(
				scripts.map(({ code, module }) => ({ code, module: !!module })),
			),
			maxBuffer: 1 << 30,
			encoding: 'utf8',
		},
	);
	if (child.status !== 0)
		throw new Error(`v8-verdicts.mjs failed: ${child.stderr}`);
	return JSON.parse(child.stdout);
}
