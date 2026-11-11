// The scanner module (rust/rwcss, `scanner.wasm`) as its callers see it: a
// stylesheet, a declaration list or a single value rewritten, and where a
// document's inline scripts and styles stand. The CSS rewrite is the whole
// rewrite, done in the module (css-tree's tokenizer and parsers ported, the
// replacements spliced into the text there): what it asks of this thread is
// only what a URL routes to, since the base URL, the codec and the config
// live here. Its output is the JavaScript rewriter's byte for byte, so
// which of the two rewrote a sheet shows nowhere but in the time it took.
// The markup scan only finds; what is done with each element is
// src/prewrite.ts's own code. Every function answers null when this thread
// holds no scanner or the scanner declined the input, and the caller then
// does the work in JavaScript as it always did.
import { routeCSS } from '../cssURLs';
import { routeBinary } from '../routeURL';
import StompURL from '../StompURL';
import type { RouteImport } from './module';
import { withInstance } from './thread';

/** the scanner's Assets key (src/config.ts) */
export const SCANNER = 'scanner';

// rust/rwcss/src/lib.rs
const MARKUP = 2;
const REWRITE_SHEET = 3;
const REWRITE_LIST = 4;
const REWRITE_VALUE = 5;
/** the text comes back as it was: there is no answer to copy out */
const UNCHANGED = 7;

// rust/rwcss/src/rewrite.rs: what the module asks to have routed
/** a url() the expression found, a string of image-set() or src(): binary, and a failure says nothing */
const ROUTE_QUIET = 1;
// (2: a url() token, binary; routed like 1, and a failure is reported)
/** an @import's url(): a stylesheet */
const ROUTE_STYLE = 3;
/** an @import's string: a stylesheet, unless it is routed already */
const ROUTE_IMPORT = 4;
/** the next part of an answer too long for one (rust/rwcss/src/abi.rs) */
const ROUTE_MORE = 0;
const PART = '\x01';
const LAST = '\x02';
/**
 * How many UTF-16 units of an answer go in one part: the module's scratch
 * is 64 KiB and a unit is at most three bytes of UTF-8
 */
const PART_UNITS = 16 * 1024;

/**
 * What answers the module's routing calls while it rewrites CSS of the
 * document at `url`: the routed URL, or null to leave the piece as written
 * (the text is no URL, or an @import that is routed already), exactly where
 * `route` in src/rewriteCSS.ts and rewriteCSSValueURLs leave it.
 */
function styleRoute(url: StompURL): RouteImport {
	const base = url.toString();
	const imported = `${url.directory}css/`;
	/** what is left of an answer that goes over in parts */
	let rest = '';
	const part = (): string => {
		let end = Math.min(PART_UNITS, rest.length);
		// a pair of surrogates stays in one part
		if (end < rest.length && (rest.charCodeAt(end - 1) & 0xfc00) === 0xd800)
			end--;
		const text = rest.slice(0, end);
		rest = rest.slice(end);
		return (rest ? PART : LAST) + text;
	};
	return (kind, text) => {
		if (kind === ROUTE_MORE) return part();
		let routed: string;
		try {
			if (kind === ROUTE_IMPORT && text.startsWith(imported)) return null;
			const resolved = new StompURL(new URL(text, base), url);
			routed =
				kind === ROUTE_STYLE || kind === ROUTE_IMPORT
					? routeCSS(resolved, url)
					: routeBinary(resolved);
		} catch (error) {
			// a URL that does not parse loads nothing natively, and says
			// nothing: left as written
			if (kind !== ROUTE_QUIET && !(error instanceof TypeError))
				console.error(error);
			return null;
		}
		// whole, unless it is too long for the scratch or could be taken
		// for a part
		if (routed.length <= PART_UNITS && routed.charCodeAt(0) > 2) return routed;
		rest = routed;
		return part();
	};
}

/**
 * Whether the module can be handed `text` and give the JavaScript
 * rewriter's bytes back: the text crosses as UTF-8, which has no lone
 * surrogate (it would come back as U+FFFD)
 */
function crosses(text: string): boolean {
	const wellFormed = (text as { isWellFormed?: () => boolean }).isWellFormed;
	return typeof wellFormed === 'function'
		? wellFormed.call(text)
		: !/[\ud800-\udfff]/.test(text);
}

/** `text` rewritten by the module under `flags`, or null */
function rewritten(text: string, url: StompURL, flags: number): string | null {
	if (!crosses(text)) return null;
	// the answer is read by a decoder that drops a leading byte order mark;
	// the module answers only with one where the text began with one
	const marked = text.charCodeAt(0) === 0xfeff;
	return withInstance(
		SCANNER,
		(instance) => {
			const result = instance.call(text, flags);
			if ('output' in result)
				return marked ? `\ufeff${result.output}` : result.output;
			return result.status === UNCHANGED ? text : null;
		},
		styleRoute(url),
	);
}

/**
 * modifyCSS in the module: the stylesheet or declaration list `text` of
 * the document at `url` with every URL routed (`context` as modifyCSS
 * takes it), or null when JavaScript has to do it: this thread holds no
 * module, the module is in a call already (a data: stylesheet imported by
 * the sheet being rewritten), it declined the text, or the context is one
 * it does not rewrite.
 */
export function rewriteStyles(
	text: string,
	url: StompURL,
	context: string,
): string | null {
	const flags =
		context === 'stylesheet'
			? REWRITE_SHEET
			: context === 'declarationList'
				? REWRITE_LIST
				: null;
	return flags === null ? null : rewritten(text, url, flags);
}

/** rewriteCSSValueURLs in the module: the url()s of a single value routed, or null as for rewriteStyles */
export function rewriteValueURLs(value: string, url: StompURL): string | null {
	return rewritten(value, url, REWRITE_VALUE);
}

/** an element's start tag attributes and its text, where they stand in the markup */
export type MarkupElement = [
	attributesStart: number,
	attributesEnd: number,
	textStart: number,
	textEnd: number,
];

/** what src/prewrite.ts's three expressions match in a document's markup */
export interface MarkupScan {
	/** the markup sets a base URL (`hasBase`) */
	base: boolean;
	/** every `<script>` element, in source order */
	scripts: MarkupElement[];
	/** every `<style>` element, in source order */
	styles: MarkupElement[];
}

/** the module's scan of `text`: lines of a letter and numbers, or null */
function scan(text: string, flags: number): [string, number[]][] | null {
	const answer = withInstance(SCANNER, (instance) => {
		const result = instance.call(text, flags);
		return 'output' in result ? result.output : null;
	});
	if (answer === null) return null;
	const lines: [string, number[]][] = [];
	for (const line of answer.split('\n')) {
		if (!line) continue;
		const numbers = line.slice(2).split(' ').map(Number);
		// an answer this code does not read is no answer
		if (
			numbers.some(
				(value) => !Number.isInteger(value) || value < 0 || value > text.length,
			)
		)
			return null;
		lines.push([line[0], numbers]);
	}
	return lines;
}

/** the `<script>` and `<style>` elements of `markup`, and whether it sets a base URL */
export function scanMarkup(markup: string): MarkupScan | null {
	const lines = scan(markup, MARKUP);
	if (!lines) return null;
	const found: MarkupScan = { base: false, scripts: [], styles: [] };
	let based = false;
	for (const [kind, numbers] of lines) {
		if (kind === 'B' && numbers.length === 1) {
			found.base = numbers[0] === 1;
			based = true;
		} else if ((kind === 'J' || kind === 'C') && numbers.length === 4)
			(kind === 'J' ? found.scripts : found.styles).push(
				numbers as MarkupElement,
			);
		else return null;
	}
	return based ? found : null;
}
