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
//
// The markup's handler attributes (onclick) go the same way: the client
// rewrote each as its element was copied, and placed it in the markup (where
// its start tag ends, which V8 counts its positions from). That was most of
// what a frame with one handler cost (some 7 KB of heap: the rewrite's calls
// and the scan of the markup, measured, Chrome 157). The worker sends each
// text's rewrite once and the place of every attribute of that name and
// text, in the markup's order, and the client takes them in the order it
// copies them. A handler the scan cannot read as the parser does (a
// character reference in it, a carriage return) is rewritten and placed in
// the page as before.

import { holderStatement, sourceKey } from './functionSource';
import { accessExpression } from './helperNames';
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
	 * markup (start, end), its rewrite (PackedRewrite), the map the rewrite
	 * handed over apart ('' for none: src/wasm/rewriter.ts takeApart), and
	 * where its text starts in the document (the lines before, the column:
	 * src/rewriteJS.ts ScriptSource.place)]
	 */
	scripts: [
		kind: 'c' | 'm',
		start: number,
		end: number,
		...PackedRewrite,
		map: string,
		place: [before: number, column: number],
	][];
	/** [where the style's text stands in the markup (start, end), its rewrite] */
	styles: [start: number, end: number, output: string][];
	/**
	 * [where a handler's text stands in the markup (start, end), its rewrite
	 * as the client makes it (handlerPreamble's preamble, no holder: the
	 * client keeps the text), the map the rewrite handed over apart, and each
	 * attribute of that text: its name and where its start tag ends in the
	 * document (the lines before, the column: ScriptSource.place)]
	 */
	handlers?: [
		start: number,
		end: number,
		output: string,
		map: string,
		places: [name: string, before: number, column: number][],
	][];
}

/**
 * What a handler's rewrite runs first (src/inject/dom/modules/DOMAttributes.ts):
 * the page's policy judges it as it runs (DocumentClient.codeRuns)
 */
export const handlerPreamble = (access: string, key: string) =>
	`if(${accessExpression(access)}.csp(this,"${key}"))return;`;

/** the rewrite `packed` stands for (the preamble only when `preamble`) */
function unpack(
	kind: 'c' | 'm',
	source: string,
	[rest, at, holder]: readonly [...PackedRewrite, ...unknown[]],
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
export const JS_MIME_TYPES = new Set([
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

/** a start tag: its name and attributes (src/inject/dom/markupPlaces.ts TAGS) */
const TAG = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
/** what holds no tags: a comment, or a raw text element's start tag (its text follows) */
const UNTAGGED =
	/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
/** what may start a handler attribute */
const HANDLER_LIKE = /[\s/"']on[a-z]+\s*=/gi;
/** an attribute and its value, quoted or not */
const ATTRIBUTE = /[\s/]([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
/** past this many handler texts the rest are left to the page */
const HANDLER_LIMIT = 1024;

/**
 * The handler attributes of `markup` (an `on` and letters, the first of its
 * name in its tag), each text once with where it first stands, and every
 * attribute of that text: its name and where its start tag ends. Read as
 * the client's handlerPlace reads them (src/inject/dom/markupPlaces.ts):
 * comments and the text of raw text elements hold none. Only the tags
 * around what looks like one are read. A value with a character reference
 * or a carriage return is not the text the parser gives the element: it is
 * left out.
 */
export function handlerSources(
	markup: string,
): [source: string, start: number, end: number, places: [string, number][]][] {
	const found = new Map<string, [string, number, number, [string, number][]]>();
	let total = 0;
	const untagged = new RegExp(UNTAGGED);
	let next = untagged.exec(markup);
	/** the comment or raw text read last (from, to), and where the last tag read ends */
	let from = -1;
	let to = -1;
	let read = 0;
	const candidates = new RegExp(HANDLER_LIKE);
	for (let candidate; (candidate = candidates.exec(markup));) {
		const at = candidate.index;
		if (at < read) continue;
		// the last comment or raw text that starts before it, which it may be
		// in (a raw text element's start tag holds attributes)
		while (at >= to && next && next.index < at) {
			from = next.index;
			to = from + next[0].length;
			if (next[1]) {
				from = to;
				const close = new RegExp(`</${next[1]}(?=[\\s/>])`, 'gi');
				close.lastIndex = to;
				to = close.test(markup) ? close.lastIndex : markup.length;
			}
			untagged.lastIndex = Math.max(to, next.index + 1);
			next = untagged.exec(markup);
		}
		if (at >= from && at < to) continue;
		const open = markup.lastIndexOf('<', at);
		if (open < read) continue;
		TAG.lastIndex = open;
		const tag = TAG.exec(markup);
		if (!tag || TAG.lastIndex <= at) continue;
		const end = (read = TAG.lastIndex);
		const seen = new Set<string>();
		const rest = open + 1 + tag[1]!.length;
		for (const attribute of tag[2]!.matchAll(ATTRIBUTE)) {
			const name = attribute[1]!.toLowerCase();
			if (seen.has(name)) continue;
			seen.add(name);
			if (!/^on[a-z]+$/.test(name)) continue;
			const value = attribute[2] ?? attribute[3] ?? attribute[4]!;
			if (value.includes('&') || value.includes('\r')) continue;
			const known = found.get(value);
			if (known) {
				known[3].push([name, end]);
				continue;
			}
			if (found.size >= HANDLER_LIMIT) continue;
			if ((total += value.length) > LIMIT) return [...found.values()];
			const valueEnd =
				rest +
				attribute.index! +
				attribute[0].length -
				(attribute[4] === undefined ? 1 : 0);
			found.set(value, [
				value,
				valueEnd - value.length,
				valueEnd,
				[[name, end]],
			]);
		}
	}
	return [...found.values()];
}

/**
 * A directive prologue as a rewriter writes it: the JavaScript one prints
 * the directives alone, the wasm one leaves the page's own text, with its
 * spacing and comments
 */
const PROLOGUE =
	/^(?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n|(?:'[^'\\\n]*'|"[^"\\\n]*")\s*;)*$/;

/** the client's lookup of a Prewritten table */
export class PrewrittenTable {
	/** each script's rewrite, then its map and where it stands (PrewrittenTable's) */
	readonly #scripts = new Map<
		string,
		[...PackedRewrite, map?: string, place?: [number, number]]
	>();
	readonly #styles = new Map<string, string>();
	/**
	 * each handler text's rewrite, its map and the places of the attributes
	 * of each name, `next` the one to take (made with the first handler: a
	 * frame's table seldom has any)
	 */
	#handlers?: Map<
		string,
		[
			output: string,
			map: string,
			places: Record<string, { next: number; places: [number, number][] }>,
		]
	>;
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
		this.add(table, markup);
	}
	/** the table of another piece of the document's markup (`markup`, which it names its texts in) */
	add(table: Prewritten, markup: string) {
		if (table.url !== this.url) return;
		for (const [kind, start, end, ...packed] of table.scripts)
			this.#scripts.set(`${kind}\u0000${markup.slice(start, end)}`, packed);
		for (const [start, end, output] of table.styles)
			this.#styles.set(markup.slice(start, end), output);
		for (const [start, end, output, map, places] of table.handlers ?? []) {
			const source = markup.slice(start, end);
			const handlers = (this.#handlers ??= new Map());
			let known = handlers.get(source);
			if (!known)
				handlers.set(
					source,
					(known = [output, map, { __proto__: null } as never]),
				);
			for (const [name, before, column] of places) {
				const kept = (known[2][name] ??= { next: 0, places: [] });
				kept.places[kept.places.length] = [before, column];
			}
		}
	}
	/**
	 * The rewrite of a handler of this text and its map, and when `placed` (an
	 * attribute the parser gave an element of the markup) where it stands:
	 * the next place of an attribute of its name and text
	 */
	handler(
		name: string,
		source: string,
		placed: boolean,
	): [output: string, map: string, place?: [number, number]] | undefined {
		const found = this.#handlers?.get(source);
		if (!found) return undefined;
		if (!placed) return [found[0], found[1]];
		const kept = found[2][name];
		const place = kept ? kept.places[kept.next++] : undefined;
		return [found[0], found[1], place];
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
		const packed = (this.found = this.#scripts.get(`${kind}\u0000${source}`));
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
	/** the entry script() last found: its map is at 3, where it stands in the document at 4 */
	found?: [...PackedRewrite, map?: string, place?: [number, number]];
	style(source: string): string | undefined {
		return this.#styles.get(source);
	}
	/** the style text whose rewrite is `output`, if the table has one */
	styleSource(output: string): string | undefined {
		for (const [source, rewrite] of this.#styles)
			if (rewrite === output) return source;
		return undefined;
	}
}
