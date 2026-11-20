// Where the page's markup has a script or a handler (a deferred part,
// ./deferredParts.ts): the place V8 counts an inline script or a handler of
// the parser from (codePlace, handlerPlace, which the rewrite's position map
// takes: Client.ts rewriteInlineScripts, modules/DOMAttributes.ts) and the
// place a markup script's violation names (markupScriptSite). Apart from
// ./violations.ts, whose group is some 8 KB of code: a frame of the markup
// whose handler is placed as it is copied (most ad frames have one)
// evaluated all of it, about 10 KB of heap a frame, for these few
// functions (measured, Chrome 157, test/frame-memory.mjs).
import { LazyMap, LazyWeakMap } from '../ownCollections';
import type DocumentClient from './Client';
import type { Site } from './violations';

/** a URL as a violation names it: without its query and fragment */
const sourceName = (url: string) => url.replace(/[?#].*$/s, '');

/**
 * The markup's comments and raw text elements, each element's name, start
 * tag's rest and text (scripting on: a noscript's is text)
 */
const MARKUP_TEXTS =
	/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(?:<\/\1(?=[\s/>])[^>]*>|$)/gi;
/**
 * How far a client's markup is read for its scripts or the handlers of a
 * name: where the next search starts, and the place lines are counted to,
 * its line and the line's start
 */
type Scan = [number, number, number, number];
/** each client's scans: for its violations (markupScriptSite), its scripts' and handlers' positions (codePlace, handlerPlace) */
const scans = new LazyWeakMap<object, LazyMap<string, Scan>>();

/**
 * The line (from 1) of `at` in the client's markup, counted on from where
 * scan `which` last counted to (lines are line feeds: a carriage return
 * alone ends none), its next search to start at `next`
 */
function lineOf(
	client: DocumentClient,
	which: string,
	at: number,
	next: number,
): [number, number] {
	let kept = scans.get(client);
	if (!kept) scans.set(client, (kept = new LazyMap()));
	const scanned = kept.get(which) ?? [0, 0, 1, 0];
	let [, , line, start] = scanned;
	const ends = /\n/g;
	ends.lastIndex = scanned[1];
	for (let end; (end = ends.exec(client.markupSoFar)) && end.index < at;) {
		line++;
		start = ends.lastIndex;
	}
	kept.set(which, [next, at, line, start]);
	return [line, start];
}

/**
 * Where the page's markup has the inline script of the parser whose text is
 * `text` (the next such one after the last scan `which` found): where its
 * text starts, its line and the line's start
 */
function scriptIn(
	client: DocumentClient,
	text: string,
	which: string,
): [number, number, number] | undefined {
	const scan = new RegExp(MARKUP_TEXTS);
	scan.lastIndex = scans.get(client)?.get(which)?.[0] ?? 0;
	for (let match; (match = scan.exec(client.markupSoFar));) {
		if (match[1]?.toLowerCase() !== 'script') continue;
		if (match[3].replace(/\r\n?/g, '\n') !== text) continue;
		const at = match.index + match[1].length + match[2].length + 1;
		return [at, ...lineOf(client, which, at, scan.lastIndex)];
	}
	return undefined;
}

/**
 * Where the page's markup has the inline script of the parser whose text is
 * `text` (the next such one after the last found): the place Chrome names
 * for its violation, the document's URL and the line and column where its
 * text starts: its lines are its line feeds (a carriage return alone ends
 * none) and its columns UTF-16 units (measured, Chrome 157)
 */
export function markupScriptSite(
	client: DocumentClient,
	text: string,
): Site | undefined {
	const found = scriptIn(client, text, '');
	return found
		? [sourceName(client.url.url.href), found[1], found[0] - found[2] + 1]
		: undefined;
}

/**
 * Where V8 counts a script of the document from (the next inline script of
 * the parser whose text is `text`): the lines before the one its text
 * starts on, and the column (UTF-16 units) it starts at there (measured,
 * Chrome 157: a frame's line is the document's, and so its first line's
 * column; the map of its rewrite places it, ../positionParts.ts keepCode)
 */
export function codePlace(
	client: DocumentClient,
	text: string,
): [number, number] | undefined {
	const found = scriptIn(client, text, 's');
	return found ? [found[1] - 1, found[0] - found[2]] : undefined;
}

/** a comment, or a start tag: its name and attributes */
const TAGS =
	/<!--[\s\S]*?(?:-->|$)|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
/** the elements whose text holds no tags */
const RAW =
	/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/i;
/** an attribute and its value, quoted or not */
const ATTRIBUTE = /[\s/]([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
/** the character references a handler is likely written with */
const REFERENCE = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));?/gi;
const NAMED_REFERENCES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
};

/**
 * Where V8 counts a handler of the page's markup from (the next attribute
 * `name` whose value is `text`): where its start tag ends, the lines
 * before that one and the column (measured, Chrome 157: a handler's frame's
 * line is the tag end's and its body's, its first line's column the tag
 * end's and its own)
 */
export function handlerPlace(
	client: DocumentClient,
	name: string,
	text: string,
): [number, number] | undefined {
	const markup = client.markupSoFar;
	const which = `h${name.toLowerCase()}`;
	const tags = new RegExp(TAGS);
	tags.lastIndex = scans.get(client)?.get(which)?.[0] ?? 0;
	for (let tag; (tag = tags.exec(markup));) {
		if (!tag[1]) continue;
		const end = tags.lastIndex;
		if (RAW.test(tag[1])) {
			const close = new RegExp(`</${tag[1]}(?=[\\s/>])`, 'gi');
			close.lastIndex = end;
			tags.lastIndex = close.test(markup) ? close.lastIndex : markup.length;
		}
		for (const [, attribute, double, single, bare] of tag[2]!.matchAll(
			ATTRIBUTE,
		)) {
			if (attribute!.toLowerCase() !== which.slice(1)) continue;
			// (the first of a name is the element's)
			const value = (double ?? single ?? bare!)
				.replace(/\r\n?/g, '\n')
				.replace(REFERENCE, (whole, decimal, hex, named) =>
					named
						? NAMED_REFERENCES[named.toLowerCase()]!
						: String.fromCodePoint(
								Math.min(parseInt(decimal ?? hex, decimal ? 10 : 16), 0x10ffff),
							),
				);
			if (value !== text) break;
			const [line, start] = lineOf(client, which, end, tags.lastIndex);
			return [line - 1, end - start];
		}
	}
	return undefined;
}
