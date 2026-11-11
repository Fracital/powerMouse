// A document's inline scripts and styles rewritten before the page gets
// them. The client rewrote every one on the page's main thread while it
// loaded the document (loadHTML), and that was the page's longest task:
// CNN's inline scripts and 3 MB of inline CSS took 1.7 s of it, Google's
// a fifth of a second (four times that on a slower machine). The service
// worker finds them in the markup, has the rewrite workers rewrite the
// scripts side by side (and keeps them in the rewrite cache), rewrites the
// styles, and sends the outputs with the markup. The client looks each of
// its scripts and styles up by its kind and its exact text and rewrites only
// what is not there, so a script this scan reads differently from the
// browser's parser (an escaped `</script>` in a comment, an attribute
// written with entities) is rewritten in the page as before: nothing is
// taken on trust but identical input.
//
// The table goes to the page as a string literal in the shell, which the
// page's main thread parses: a rewrite of a script holds the script's text
// twice besides the code (its preamble, and the holder its functions'
// sources are read from), and with the text itself as the key CNN's table
// was about 14 MB for 3.5 MB of script, 0.7 s to compile. So a text is
// named by where it stands in the markup the client has anyway (the client
// slices it out and still looks up by the exact text), and the preamble and
// the holder, which the client makes from the text, are cut out of the
// rewrite; the worker sends a rewrite whole when putting them back would
// not give it byte for byte.

import { holderStatement, sourceKey } from './functionSource';
import type { MarkupElement, MarkupScan } from './wasm/scanner';

/** an inline classic script's first statement: `document.currentScript.textContent` reads back as the page wrote it */
export const scriptPreamble = (source: string) =>
	`document.currentScript.textContent = ${JSON.stringify(source)};`;

/**
 * A script's rewrite as the table carries it: `rest`, the rewrite with its
 * preamble (a classic script's) and its holder statement (if `holder`) cut
 * out at `at`; or the whole rewrite, when `at` is -1
 */
export type PackedRewrite = [rest: string, at: number, holder: 0 | 1];

/** what the worker made of a document's inline scripts and styles */
export interface Prewritten {
	/** the URL the outputs were made for (the client's own, which a <base> changes) */
	url: string;
	/**
	 * [kind (c: classic, m: module), where the script's text stands in the
	 * markup (start, end), its rewrite (PackedRewrite)]
	 */
	scripts: [kind: 'c' | 'm', start: number, end: number, ...PackedRewrite][];
	/** [where the style's text stands in the markup (start, end), its rewrite] */
	styles: [start: number, end: number, output: string][];
}

/** the rewrite `packed` stands for (the preamble only when `preamble`) */
function unpack(
	kind: 'c' | 'm',
	source: string,
	[rest, at, holder]: PackedRewrite,
	access: string,
	preamble = true,
): string {
	if (at === -1) return rest;
	return (
		rest.slice(0, at) +
		(kind === 'c' && preamble ? scriptPreamble(source) : '') +
		(holder ? (holderStatement(access, sourceKey(source), source) ?? '') : '') +
		rest.slice(at)
	);
}

/**
 * `output`, the rewrite of the inline script `source` (with its preamble,
 * if classic) under the access helper `access`, as the table carries it
 */
export function packRewrite(
	kind: 'c' | 'm',
	source: string,
	output: string,
	access: string,
): PackedRewrite {
	const whole: PackedRewrite = [output, -1, 0];
	const preamble = kind === 'c' ? scriptPreamble(source) : '';
	const holder = holderStatement(access, sourceKey(source), source) ?? '';
	const at = preamble
		? output.indexOf(preamble)
		: holder
			? output.indexOf(holder)
			: -1;
	if (at === -1) return whole;
	const held = holder !== '' && output.startsWith(holder, at + preamble.length);
	const packed: PackedRewrite = [
		output.slice(0, at) +
			output.slice(at + preamble.length + (held ? holder.length : 0)),
		at,
		held ? 1 : 0,
	];
	return unpack(kind, source, packed, access) === output ? packed : whole;
}

/** the MIME types a classic script may name, as Chrome takes them (DOMAttributes' scriptKind) */
const JS_MIME_TYPES = new Set([
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'text/ecmascript',
	'text/javascript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
	'text/jscript',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
]);

const attribute = (attributes: string, name: string): string | null => {
	const match = new RegExp(
		`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		'i',
	).exec(attributes);
	if (match) return match[1] ?? match[2] ?? match[3] ?? '';
	return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'i').test(attributes)
		? ''
		: null;
};

/** a script's kind from its start tag's attributes, as scriptKind decides it from the element */
function kindOf(attributes: string): 'c' | 'm' | null {
	let type = attribute(attributes, 'type');
	if (type === null) {
		const language = attribute(attributes, 'language');
		type = language ? `text/${language}` : '';
	}
	if (type.toLowerCase() === 'module') return 'm';
	type = type.trim().toLowerCase();
	if (type === '') return 'c';
	return JS_MIME_TYPES.has(type) ? 'c' : null;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
/** past this much inline text the rest is left to the page */
const LIMIT = 16 * 1024 * 1024;

/**
 * Whether the markup sets a base URL: the client rewrites against it, and
 * the worker does not know it, so such a document is left to the client
 */
export const hasBase = (markup: string) =>
	/<base\b[^>]*\shref\s*=/i.test(markup);

/** where an element's text stands in `markup`: before its end tag, the last `</` of the match */
const textRange = (
	markup: string,
	match: RegExpMatchArray,
	text: string,
): [number, number] => {
	const end = match.index! + match[0].lastIndexOf('</');
	return [end - text.length, end];
};

/**
 * The elements `pattern` matches in `markup` (start tag attributes, text,
 * where the text stands), or the same elements as the scanner found them
 * (src/wasm/scanner.ts)
 */
function* elements(
	markup: string,
	pattern: RegExp,
	scanned?: MarkupElement[],
): Generator<[attributes: string, source: string, start: number, end: number]> {
	if (scanned) {
		for (const [attributesStart, attributesEnd, start, end] of scanned)
			yield [
				markup.slice(attributesStart, attributesEnd),
				markup.slice(start, end),
				start,
				end,
			];
		return;
	}
	for (const match of markup.matchAll(pattern))
		yield [match[1]!, match[2]!, ...textRange(markup, match, match[2]!)];
}

/**
 * The inline scripts (that run) and styles of `markup`, each text once, with
 * where it first stands in the markup. `scan`: the elements as the scanner
 * found them (`rewriter: 'wasm'`), read here as the expressions' matches
 * are, so the answer is the same.
 */
export function inlineSources(
	markup: string,
	scan?: MarkupScan,
): {
	scripts: [kind: 'c' | 'm', source: string, start: number, end: number][];
	styles: [source: string, start: number, end: number][];
} {
	const scripts = new Map<string, ['c' | 'm', string, number, number]>();
	const styles = new Map<string, [string, number, number]>();
	let total = 0;
	for (const [attributes, source, start, end] of elements(
		markup,
		SCRIPT,
		scan?.scripts,
	)) {
		if (!source.trim() || attribute(attributes, 'src') !== null) continue;
		const kind = kindOf(attributes);
		if (kind === null) continue;
		if ((total += source.length) > LIMIT) break;
		const key = `${kind}\u0000${source}`;
		if (!scripts.has(key)) scripts.set(key, [kind, source, start, end]);
	}
	for (const [, source, start, end] of elements(markup, STYLE, scan?.styles)) {
		if (!source.trim()) continue;
		if ((total += source.length) > LIMIT) break;
		if (!styles.has(source)) styles.set(source, [source, start, end]);
	}
	return { scripts: [...scripts.values()], styles: [...styles.values()] };
}

/** a directive prologue as the rewriter prints it */
const PROLOGUE = /^(?:(?:'[^'\\\n]*'|"[^"\\\n]*");)*$/;

/** the client's lookup of a Prewritten table */
export class PrewrittenTable {
	readonly #scripts = new Map<string, PackedRewrite>();
	readonly #styles = new Map<string, string>();
	readonly #access: string;
	/** the URL the outputs were made for */
	readonly url: string;
	/**
	 * `markup`: the document's, which the table names its texts in; `access`:
	 * the access helper's name, which the holder statements call
	 */
	constructor(table: Prewritten, markup: string, access: string) {
		this.url = table.url;
		this.#access = access;
		for (const [kind, start, end, ...packed] of table.scripts)
			this.#scripts.set(`${kind}\u0000${markup.slice(start, end)}`, packed);
		for (const [start, end, output] of table.styles)
			this.#styles.set(markup.slice(start, end), output);
	}
	/**
	 * The rewrite of an inline script of this text: as the document's own
	 * (a classic one with its preamble), or `bare`, as a script the page
	 * inserts is rewritten (no preamble). The rewriter writes the preamble
	 * right after the directive prologue, so the bare rewrite is the same
	 * text without it.
	 */
	script(module: boolean, source: string, bare = false): string | undefined {
		const kind = module ? 'm' : 'c';
		const packed = this.#scripts.get(`${kind}\u0000${source}`);
		if (packed === undefined) return undefined;
		if (module || !bare) return unpack(kind, source, packed, this.#access);
		if (packed[1] !== -1)
			return PROLOGUE.test(packed[0].slice(0, packed[1]))
				? unpack(kind, source, packed, this.#access, false)
				: undefined;
		const output = packed[0];
		const preamble = scriptPreamble(source);
		const at = output.indexOf(preamble);
		if (at === -1 || !PROLOGUE.test(output.slice(0, at))) return undefined;
		return output.slice(0, at) + output.slice(at + preamble.length);
	}
	style(source: string): string | undefined {
		return this.#styles.get(source);
	}
}
