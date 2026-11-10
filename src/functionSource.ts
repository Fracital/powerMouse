// The source a page's function reads back as (Function.prototype.toString).
// The rewriter prints a script's code anew, so natively a function's source
// would be the rewriter's output: a tell, and a broken page where the source
// is used (Google's GSI puts a listener's source in its button frame's URL,
// and the frame answers 400 when it is not the page's).
//
// Each function the rewriter prints carries a mark, a comment right after
// the first token of its source (`function f/*k.s.l*/(a) {...}`): the key of
// the script it came from and where in that script's text it stands. The
// mark is the first comment of the function's own source, before anything
// that could hold another function, so the function's native source starts
// with it whatever is nested inside. The script's text is kept once, by key:
// a script the inject rewrites (inline, eval, new Function, a timer, a
// handler) is kept as it is; one the service worker rewrites carries its text
// in a comment inside a function it hands to the access API first
// (`$s$j.src(key, subs, function(){/*text*/})`), read through the native
// toString when a function of it is first read, so the page's realm keeps no
// copy of the text but the script's own source.

/** the characters a kept text cannot carry in a block comment on one line, in the order `subs` replaces them */
const CARRIED = ['*', '<', '\n', '\r', '\u2028', '\u2029'];
/** what stands for them: characters scripts do not contain (one picked per text) */
const STAND_INS = [
	1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
	25, 26, 27, 28, 29, 30, 31, 127,
].map((code) => String.fromCharCode(code));
const HOLDER_HEAD = 'function(){/*';
const HOLDER_TAIL = '*/}';

/**
 * The key a script's text is kept by: two 32-bit hashes of it, 42 bits in
 * nine base-36 digits, so two different scripts one realm runs share a key
 * once in thousands of billions
 */
export function sourceKey(text: string, map?: number[]): string {
	let a = 0x811c9dc5;
	let b = 0x9747b28c;
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i);
		if (map && c < 128) c = map[c]!;
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x5bd1e995);
		b ^= b >>> 13;
	}
	return (
		(a >>> 0).toString(36).padStart(7, '0') +
		((b >>> 0) % 1296).toString(36).padStart(2, '0')
	);
}

/** the mark of a function at [start, end) of the text kept by `key` */
export const functionMark = (key: string, start: number, end: number) =>
	`/*${key}.${start.toString(36)}.${(end - start).toString(36)}*/`;

/**
 * The mark an event handler attribute's code starts with: the browser
 * compiles it as the body of `function onclick(event) {\n...\n}`, which
 * reads back with the page's text in place of the body
 */
export const handlerMark = (key: string) => `/*${key}*/`;

/**
 * The statement that hands a script's text to the access API, written by the
 * rewriter that runs where no page does (the service worker, a rewrite
 * worker): null when the text holds every stand-in character
 */
export function holderStatement(access: string, key: string, text: string) {
	const subs: string[] = [];
	for (const candidate of STAND_INS) {
		if (subs.length === CARRIED.length) break;
		if (!text.includes(candidate)) subs.push(candidate);
	}
	if (subs.length < CARRIED.length) return null;
	let encoded = text;
	CARRIED.forEach((c, i) => {
		if (encoded.includes(c)) encoded = encoded.replaceAll(c, subs[i]!);
	});
	return `typeof ${access}!=="undefined"&&${access}.src(${JSON.stringify(key)},${JSON.stringify(subs.join(''))},${HOLDER_HEAD}${encoded}${HOLDER_TAIL});`;
}

let here = false;
// the rewriter library's (src/rewriterLib.ts): it keeps no text, it tells
// the realm that asked for the rewrite what to keep under which key
let report: ((key: string, text: string) => void) | null = null;
/**
 * Called by the inject: a script rewritten in this bundle keeps its text in
 * the bundle's table, not in its output (the page's realm runs it, and
 * every realm the bundle hooks reads the same table)
 */
export function keepSourcesHere() {
	here = true;
}
export const keepsSourcesHere = () => here;
/** keep nothing here: hand each text a rewrite keeps, and its key, to `to` */
export function reportKeptSources(to: (key: string, text: string) => void) {
	here = true;
	report = to;
}

interface Kept {
	/** the text, once known to be the one the key names */
	text?: string;
	/** what the text's stand-ins stand for, when it came from a holder */
	subs?: string;
	/** holders handed over and not yet read, with their stand-ins */
	holders?: [Function, string][];
}

// one table for every realm a bundle hooks (a frame it injected reads its
// functions through the same toString hook), never reachable from the page
const kept = new Map<string, Kept>();
// the native toString, taken when the bundle loads, before any hook
const nativeToString = Function.prototype.toString;
// holders a key takes before one is read (the page can hand some over too)
const MAX_HOLDERS = 4;

/** keep a script's text the inject rewrote (it rewrote that very text) */
export function keepSource(key: string, text: string) {
	if (report) return report(key, text);
	const entry = kept.get(key);
	if (entry?.text === undefined) kept.set(key, { text });
}

/**
 * Keep a script's text the service worker wrote into it (`$s$j.src`). The
 * page can call this too, which never changes how a script's functions
 * read: a function marked with a key exists only once the script ran and
 * handed its own holder over, so a key with one holder has the script's,
 * and of several the one whose text hashes to the key is believed (once,
 * when a function of the script is first read: 50 ms for 13 MB)
 */
export function keepEmbedded(key: unknown, subs: unknown, holder: unknown) {
	if (
		typeof key !== 'string' ||
		typeof subs !== 'string' ||
		subs.length !== CARRIED.length ||
		typeof holder !== 'function'
	)
		return;
	let entry = kept.get(key);
	if (!entry) kept.set(key, (entry = {}));
	if (entry.text !== undefined) return;
	entry.holders ??= [];
	if (entry.holders.length < MAX_HOLDERS) entry.holders.push([holder, subs]);
}

/** the key of a holder's text, its stand-ins read as what they stand for */
function encodedKey(encoded: string, subs: string): string {
	const map: number[] = [];
	for (let i = 0; i < 128; i++) map.push(i);
	for (let i = 0; i < CARRIED.length; i++)
		map[subs.charCodeAt(i)] = CARRIED[i]!.charCodeAt(0);
	return sourceKey(encoded, map);
}

function textOf(key: string, entry: Kept): string | null {
	const contested = (entry.holders?.length ?? 0) > 1;
	while (entry.text === undefined && entry.holders?.length) {
		const [holder, subs] = entry.holders.shift()!;
		let source: string;
		try {
			source = Reflect.apply(nativeToString, holder, []);
		} catch (error) {
			continue;
		}
		if (!source.startsWith(HOLDER_HEAD) || !source.endsWith(HOLDER_TAIL))
			continue;
		const encoded = source.slice(HOLDER_HEAD.length, -HOLDER_TAIL.length);
		if (contested && encodedKey(encoded, subs) !== key) continue;
		entry.text = encoded;
		entry.subs = subs;
		entry.holders = undefined;
	}
	return entry.text ?? null;
}

function decode(text: string, subs: string | undefined): string {
	if (subs === undefined) return text;
	for (let i = 0; i < CARRIED.length; i++)
		if (text.includes(subs[i]!)) text = text.replaceAll(subs[i]!, CARRIED[i]!);
	return text;
}

const MARK = /\/\*([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\*\//y;
// the browser's wrapper of a handler attribute's body
const HANDLER = /^function [^\s(]*\([^)]*\) \{\n\/\*([0-9a-z]+)\*\//;

/**
 * The source a function's native source (the rewriter's output) stands
 * for, or null when it carries no mark this realm knows. A mark comes after
 * the first token, with nothing that holds a comment before it but a quoted
 * method or pattern key: the scan skips strings and gives up at anything a
 * mark never follows (an `=`, a `;`, a `}`), so a function the rewriter
 * made itself, which has none, never reads as the first page function
 * nested in it.
 */
export function originalSource(native: string): string | null {
	const handler = HANDLER.exec(native);
	if (handler) {
		const entry = kept.get(handler[1]!);
		if (!entry || !native.endsWith('\n}')) return null;
		const text = textOf(handler[1]!, entry);
		if (text === null) return null;
		const at = handler[0].length - handler[1]!.length - 4;
		return native.slice(0, at) + decode(text, entry.subs) + '\n}';
	}
	for (let i = 0; i < native.length; i++) {
		const c = native[i];
		if (c === '"' || c === "'") {
			for (i++; i < native.length && native[i] !== c; i++)
				if (native[i] === '\\') i++;
			continue;
		}
		if (c === '/') {
			MARK.lastIndex = i;
			const mark = MARK.exec(native);
			if (!mark) return null;
			const entry = kept.get(mark[1]!);
			if (!entry) return null;
			const text = textOf(mark[1]!, entry);
			if (text === null) return null;
			const start = parseInt(mark[2]!, 36);
			const end = start + parseInt(mark[3]!, 36);
			if (end > text.length) return null;
			return decode(text.slice(start, end), entry.subs);
		}
		// (a parameter pattern's `{` and a readable one's line breaks come
		// before its mark)
		if (c === '=' || c === ';' || c === '}') return null;
	}
	return null;
}
