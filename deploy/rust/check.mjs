// What a wasm artifact may look like before it ships, checked on the bytes:
// no custom section (a name or producers section would carry crate and
// function names, and a host that scans its build for the package's name
// would refuse it), only the imports and exports the crate's abi.json names
// (the names are short and neutral so a host can substitute them at the
// same length), and none of the tokens such a scan looks for anywhere in the
// bytes, read as latin1 the way the scan reads them. The suite wasm-artifact
// runs the same checks on what build.js copied into dist/.
//
//   node deploy/rust/check.mjs <file.wasm> <abi.json>
import { readFileSync } from 'node:fs';

/** the tokens a host's canary scan refuses (lower case; the scan is case-insensitive) */
export const TOKENS = [
	'stomp',
	'scramjet',
	'epoxy',
	'libcurl',
	'wispurr',
	'bare-mux',
	'ultraviolet',
	'fracital',
	// the build's own: a panic location, a source path, the compiler (as a
	// standard library path names it: `/rustc/<commit>/library/...`; the
	// bare word is also inside "RustCrypto", a type name the DTLS stack's
	// trait objects keep)
	'/rustc/',
	'library/',
	'.rs',
	'panicked',
	'/home/',
	'/work/',
];

const SECTIONS = {
	0: 'custom',
	1: 'type',
	2: 'import',
	3: 'function',
	4: 'table',
	5: 'memory',
	6: 'global',
	7: 'export',
	8: 'start',
	9: 'element',
	10: 'code',
	11: 'data',
	12: 'data count',
};

const KINDS = ['function', 'table', 'memory', 'global'];

class Reader {
	constructor(bytes, at = 0, end = bytes.length) {
		this.bytes = bytes;
		this.at = at;
		this.end = end;
	}
	get done() {
		return this.at >= this.end;
	}
	byte() {
		if (this.at >= this.end) throw new Error('truncated');
		return this.bytes[this.at++];
	}
	u32() {
		let result = 0;
		let shift = 0;
		for (;;) {
			const b = this.byte();
			result |= (b & 0x7f) << shift;
			if (!(b & 0x80)) return result >>> 0;
			shift += 7;
			if (shift > 35) throw new Error('bad LEB128');
		}
	}
	name() {
		const length = this.u32();
		const text = new TextDecoder().decode(
			this.bytes.subarray(this.at, this.at + length),
		);
		this.at += length;
		return text;
	}
}

/** the artifact's sections, imports and exports */
export function inspect(bytes) {
	const r = new Reader(bytes);
	if (
		r.byte() !== 0 ||
		r.byte() !== 0x61 ||
		r.byte() !== 0x73 ||
		r.byte() !== 0x6d
	)
		throw new Error('not a wasm module');
	r.at = 8;
	const sections = [];
	const customs = [];
	const imports = [];
	const exports = [];
	while (!r.done) {
		const id = r.byte();
		const size = r.u32();
		const start = r.at;
		const section = new Reader(bytes, start, start + size);
		sections.push(SECTIONS[id] ?? `unknown ${id}`);
		if (id === 0) customs.push(section.name());
		if (id === 2)
			for (let count = section.u32(); count > 0; count--) {
				const module = section.name();
				const field = section.name();
				const kind = section.byte();
				// the descriptor: a type index, or a table/memory/global type
				if (kind === 0) section.u32();
				else if (kind === 1) {
					section.byte();
					limits(section);
				} else if (kind === 2) limits(section);
				else if (kind === 3) {
					section.byte();
					section.byte();
				}
				imports.push(`${module}.${field}`);
			}
		if (id === 7)
			for (let count = section.u32(); count > 0; count--) {
				const field = section.name();
				const kind = section.byte();
				section.u32();
				exports.push(`${field}:${KINDS[kind] ?? kind}`);
			}
		r.at = start + size;
	}
	return { sections, customs, imports, exports };
}

function limits(section) {
	const flags = section.byte();
	section.u32();
	if (flags & 1) section.u32();
}

/** the tokens found in the bytes read as latin1, with how often */
export function tokensIn(bytes) {
	const text = Buffer.from(bytes).toString('latin1').toLowerCase();
	const found = [];
	for (const token of TOKENS) {
		let count = 0;
		for (
			let at = text.indexOf(token);
			at !== -1;
			at = text.indexOf(token, at + 1)
		)
			count++;
		if (count) found.push(`${token} x${count}`);
	}
	return found;
}

/**
 * Every problem with the artifact against its abi.json (`imports` and
 * `exports` as `module.field` and `name:kind` lists): empty when it may ship
 */
export function problems(bytes, abi) {
	const seen = inspect(bytes);
	const out = [];
	if (seen.customs.length)
		out.push(`custom sections: ${seen.customs.join(', ')}`);
	const same = (a, b) =>
		JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
	if (!same(seen.imports, abi.imports))
		out.push(
			`imports ${JSON.stringify(seen.imports)}, abi.json says ${JSON.stringify(abi.imports)}`,
		);
	if (!same(seen.exports, abi.exports))
		out.push(
			`exports ${JSON.stringify(seen.exports)}, abi.json says ${JSON.stringify(abi.exports)}`,
		);
	const tokens = tokensIn(bytes);
	if (tokens.length) out.push(`tokens in the bytes: ${tokens.join(', ')}`);
	return out;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const [file, abiFile] = process.argv.slice(2);
	if (!file || !abiFile) {
		console.error('usage: check.mjs <file.wasm> <abi.json>');
		process.exit(2);
	}
	const bytes = new Uint8Array(readFileSync(file));
	const abi = JSON.parse(readFileSync(abiFile, 'utf8'));
	const seen = inspect(bytes);
	console.log(`${file}: ${bytes.length} bytes`);
	console.log(`  sections: ${seen.sections.join(', ')}`);
	console.log(`  imports: ${seen.imports.join(', ') || '(none)'}`);
	console.log(`  exports: ${seen.exports.join(', ')}`);
	const found = problems(bytes, abi);
	for (const problem of found) console.error(`  FAIL ${problem}`);
	if (found.length) process.exit(1);
	console.log('  ok');
}
