// The scanner module (rust/rwcss, `scanner.wasm`) as the service worker
// calls it: where the pieces of a stylesheet stand that the CSS rewriter
// has to look into, and where a document's inline scripts and styles stand.
// It only finds; what is done with each piece is the JavaScript rewriters'
// own code (src/rewriteCSS.ts, src/prewrite.ts), which is why a scan gives
// their output byte for byte. Every function answers null when this thread
// holds no scanner or the scanner declined the input, and the caller then
// scans in JavaScript as it always did.
import { withInstance } from './thread';

/** the scanner's Assets key (src/config.ts) */
export const SCANNER = 'scanner';

const STYLE_SHEET = 0;
const DECLARATION_LIST = 1;
const MARKUP = 2;

/**
 * A raw piece of a stylesheet, where it stands in the text (UTF-16
 * offsets): `V` a declaration's value, `P` an at-rule's prelude (with where
 * the at-rule's name stands), `S` a rule's prelude, `R` text no parse
 * shaped (and custom property values), whose url()s the regex routes
 */
export type StylePiece =
	| [kind: 'V' | 'S' | 'R', start: number, end: number]
	| [kind: 'P', start: number, end: number, nameStart: number, nameEnd: number];

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

/** the module's answer for `text`: lines of a letter and numbers, or null */
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

/**
 * The pieces of the stylesheet `text` that modifyCSS looks into, in source
 * order; `context` as modifyCSS takes it (`stylesheet` or
 * `declarationList`)
 */
export function scanStyles(text: string, context: string): StylePiece[] | null {
	const flags =
		context === 'stylesheet'
			? STYLE_SHEET
			: context === 'declarationList'
				? DECLARATION_LIST
				: null;
	if (flags === null) return null;
	const lines = scan(text, flags);
	if (!lines) return null;
	const pieces: StylePiece[] = [];
	for (const [kind, numbers] of lines) {
		const [start, end, nameStart, nameEnd] = numbers;
		if (kind === 'P' && numbers.length === 4)
			pieces.push(['P', start, end, nameStart, nameEnd]);
		else if (
			(kind === 'V' || kind === 'S' || kind === 'R') &&
			numbers.length === 2
		)
			pieces.push([kind, start, end]);
		else return null;
	}
	return pieces;
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
