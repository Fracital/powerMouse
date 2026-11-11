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
// holds no scanner (or a scan it declined), and the caller then does the
// work in JavaScript as it always did. A rewrite made during a rewrite (a
// data: stylesheet a stylesheet imports) runs in an instance of its own
// (src/wasm/thread.ts).
import { routeCSS } from '../cssURLs';
import { routeBinary } from '../routeURL';
import StompURL from '../StompURL';
import type { RouteImport } from './module';
import { hasModule, heldModules, withInstance } from './thread';

/** the scanner's Assets key (src/config.ts) */
export const SCANNER = 'scanner';

// rust/rwcss/src/lib.rs
const MARKUP = 2;
const REWRITE_SHEET = 3;
const REWRITE_LIST = 4;
const REWRITE_VALUE = 5;
/** the text comes back as it was: there is no answer to copy out */
const UNCHANGED = 7;
/** the text has no parse: css-tree's loop over it would never end */
const STUCK = 8;

// rust/rwcss/src/rewrite.rs: what the module asks to have routed
/** a url() the expression found, a string of image-set() or src(): binary, and a failure says nothing */
const ROUTE_QUIET = 1;
// (2: a url() token, binary; routed like 1, and a failure is reported)
/** an @import's url(): a stylesheet */
const ROUTE_STYLE = 3;
/** an @import's string: a stylesheet, unless it is routed already */
const ROUTE_IMPORT = 4;

/**
 * What answers the module's routing calls while it rewrites CSS of the
 * document at `url`: the routed URL, or null to leave the piece as written
 * (the text is no URL, or an @import that is routed already), exactly where
 * `route` in src/rewriteCSS.ts and rewriteCSSValueURLs leave it.
 */
function styleRoute(url: StompURL): RouteImport {
	// made when the first URL is asked for: most values hold none that
	// routes
	let base: string | undefined;
	return (kind, text) => {
		try {
			if (kind === ROUTE_IMPORT && text.startsWith(`${url.directory}css/`))
				return null;
			base ??= url.toString();
			const resolved = new StompURL(new URL(text, base), url);
			return kind === ROUTE_STYLE || kind === ROUTE_IMPORT
				? routeCSS(resolved, url)
				: routeBinary(resolved);
		} catch (error) {
			// a URL that does not parse loads nothing natively, and says
			// nothing: left as written
			if (kind !== ROUTE_QUIET && !(error instanceof TypeError))
				console.error(error);
			return null;
		}
	};
}

/**
 * For a caller that can wait (the service worker's stylesheet route):
 * settles at once when this thread holds the scanner, and otherwise when
 * the compiles in flight are done. A worker that was just started is handed
 * the modules' bytes with its controller's handshake and has them compiled
 * 2 to 6 ms later, which is before the first stylesheet's body is in hand
 * (5 ms at the nearest, measured), so this is seldom a wait at all; without
 * it a sheet that did win that race was css-tree's. It never waits for
 * bytes that have not arrived (a controller still loading its modules).
 */
export function scannerSettled(): Promise<unknown> | void {
	if (!hasModule(SCANNER)) return heldModules();
}

/** the rewrites the module has in hand on this thread */
let inHand = 0;

/**
 * Whether the module is rewriting CSS on this thread now: what it is asked
 * to route can hold CSS of its own (the data: URL of an @import), and the
 * rewrite of that is asked of the module as the one around it was.
 */
export const rewritingStyles = (): boolean => inHand > 0;

/**
 * `text` rewritten by the module under `flags`, or null when it is
 * JavaScript's to rewrite: this thread holds no module that rewrites (none,
 * or one older than this glue), or it has INSTANCES rewrites in hand, one
 * inside another, already. Throws where css-tree would never have come
 * back.
 */
function rewritten(text: string, url: StompURL, flags: number): string | null {
	let result;
	inHand++;
	try {
		result = withInstance(
			SCANNER,
			(instance) => instance.exchange(text, flags),
			styleRoute(url),
		);
	} finally {
		inHand--;
	}
	if (result === null) return null;
	if ('output' in result) return result.output;
	if (result.status === UNCHANGED) return text;
	// thrown here, not inside the call: the instance is sound
	if (result.status === STUCK)
		throw new SyntaxError('Stomp: this CSS has no parse');
	return null;
}

/**
 * modifyCSS in the module: the stylesheet or declaration list `text` of
 * the document at `url` with every URL routed (`context` as modifyCSS
 * takes it), or null when JavaScript has to do it: this thread holds no
 * module, the sheet is nested deeper than the thread runs instances (a
 * data: stylesheet imported by the sheet being rewritten is the module's
 * too, down to the fourth), or the context is one it does not rewrite.
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
