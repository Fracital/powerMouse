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

/** an inline classic script's first statement: `document.currentScript.textContent` reads back as the page wrote it */
export const scriptPreamble = (source: string) =>
	`document.currentScript.textContent = ${JSON.stringify(source)};`;

/** what the worker made of a document's inline scripts and styles */
export interface Prewritten {
	/** the URL the outputs were made for (the client's own, which a <base> changes) */
	url: string;
	/** [kind (c: classic, m: module), the script's text, its rewrite] */
	scripts: [kind: 'c' | 'm', source: string, output: string][];
	/** [the style's text, its rewrite] */
	styles: [source: string, output: string][];
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

/** the inline scripts (that run) and styles of `markup`, each text once */
export function inlineSources(markup: string): {
	scripts: [kind: 'c' | 'm', source: string][];
	styles: string[];
} {
	const scripts = new Map<string, ['c' | 'm', string]>();
	const styles = new Set<string>();
	let total = 0;
	for (const [, attributes, source] of markup.matchAll(SCRIPT)) {
		if (!source!.trim() || attribute(attributes!, 'src') !== null) continue;
		const kind = kindOf(attributes!);
		if (kind === null) continue;
		if ((total += source!.length) > LIMIT) break;
		scripts.set(`${kind}\u0000${source}`, [kind, source!]);
	}
	for (const [, , source] of markup.matchAll(STYLE)) {
		if (!source!.trim()) continue;
		if ((total += source!.length) > LIMIT) break;
		styles.add(source!);
	}
	return { scripts: [...scripts.values()], styles: [...styles] };
}

/** a directive prologue as the rewriter prints it */
const PROLOGUE = /^(?:(?:'[^'\\\n]*'|"[^"\\\n]*");)*$/;

/** the client's lookup of a Prewritten table */
export class PrewrittenTable {
	readonly #scripts = new Map<string, string>();
	readonly #styles = new Map<string, string>();
	/** the URL the outputs were made for */
	readonly url: string;
	constructor(table: Prewritten) {
		this.url = table.url;
		for (const [kind, source, output] of table.scripts)
			this.#scripts.set(`${kind}\u0000${source}`, output);
		for (const [source, output] of table.styles)
			this.#styles.set(source, output);
	}
	/**
	 * The rewrite of an inline script of this text: as the document's own
	 * (a classic one with its preamble), or `bare`, as a script the page
	 * inserts is rewritten (no preamble). The rewriter writes the preamble
	 * right after the directive prologue, so the bare rewrite is the same
	 * text without it.
	 */
	script(module: boolean, source: string, bare = false): string | undefined {
		const output = this.#scripts.get(`${module ? 'm' : 'c'}\u0000${source}`);
		if (output === undefined || module || !bare) return output;
		const preamble = scriptPreamble(source);
		const at = output.indexOf(preamble);
		if (at === -1 || !PROLOGUE.test(output.slice(0, at))) return undefined;
		return output.slice(0, at) + output.slice(at + preamble.length);
	}
	style(source: string): string | undefined {
		return this.#styles.get(source);
	}
}
