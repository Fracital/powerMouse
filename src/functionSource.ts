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

import { accessExpression } from './helperNames';
import { LazyMap, LazyWeakMap } from './inject/ownCollections';

/** the characters a kept text cannot carry in a block comment on one line, in the order `subs` replaces them */
const CARRIED = ['*', '<', '\n', '\r', '\u2028', '\u2029'];
/** what stands for them: characters scripts do not contain (one picked per text) */
const STAND_INS = [
	1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
	25, 26, 27, 28, 29, 30, 31, 127,
].map((code) => String.fromCharCode(code));
/**
 * where the stand-ins go on when a text holds nearly every control
 * character (an obfuscated sensor's string tables do): the private use
 * area, from its start, one UTF-16 code unit each
 */
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;
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
export function holderStatement(
	access: string,
	key: string,
	text: string,
	api = accessExpression(access),
) {
	const subs: string[] = [];
	for (const candidate of STAND_INS) {
		if (subs.length === CARRIED.length) break;
		if (!text.includes(candidate)) subs.push(candidate);
	}
	for (
		let code = PRIVATE_USE_START;
		subs.length < CARRIED.length && code <= PRIVATE_USE_END;
		code++
	) {
		const candidate = String.fromCharCode(code);
		if (!text.includes(candidate)) subs.push(candidate);
	}
	if (subs.length < CARRIED.length) return null;
	let encoded = text;
	CARRIED.forEach((c, i) => {
		if (encoded.includes(c)) encoded = encoded.replaceAll(c, subs[i]!);
	});
	// (an optional call of the API where a rewritten script reaches it,
	// src/helperNames.ts accessExpression; a realm without the inject has none)
	return `${api}?.src(${JSON.stringify(key)},${JSON.stringify(subs.join(''))},${HOLDER_HEAD}${encoded}${HOLDER_TAIL});`;
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
	/**
	 * holders handed over and not yet read, with their stand-ins, held
	 * weakly: the realm that ran the script keeps its own (keepEmbedded)
	 */
	holders?: [WeakRef<Function>, string][];
	/** whether something of the page's keeps it (pin), past the table */
	pinned?: true;
}

// One table for every realm a bundle hooks (a frame it injected reads its
// functions through the same toString hook), never reachable from the page.
// Natively a script's text goes with its last function, and a page that
// evaluates many distinct scripts (eval or new Function in a loop, a
// challenge retried every second, an app injecting scripts) kept every one
// here for its life: 4 KB a script, 40 MB for 10,000. No function can be
// asked whether it lives (the browser keeps a script's text for its
// functions, never through one of them), so the table keeps the newest used
// MAX_KEPT and no more than KEPT_UNITS of the texts it owns, and an entry it
// lets go is still found by its key for as long as something of the page's
// it was pinned to lives: a function whose source was read, or that eval or
// new Function handed the page, the script element or the element of the
// handler attribute the text is of, a holder its realm keeps. A function
// none of those reach, of a script older than the newest KEPT_UNITS kept
// (one a direct eval made, or that evaluated code stored), reads as its
// rewrite without the marks (unmarked): the page's own where the rewriter
// changed nothing in it.
const kept = new LazyMap<string, Kept>();
const MAX_KEPT = 8192;
/** the most text the table holds itself, in UTF-16 units (8 to 16 MB) */
const KEPT_UNITS = 8 * 1024 * 1024;
let keptUnits = 0;
/** what keeps each entry the table may let go: weakly, by what it is of */
const pins = new LazyWeakMap<object, Kept>();
/** the entries the table let go that something pinned, by key */
const fallen = new LazyMap<string, WeakRef<Kept>>();
let sweepAt = MAX_KEPT;
/** what the texts the rewrite under way keeps are of (keptBy) */
let keeper: object | undefined;
// the native toString, taken when the bundle loads, before any hook
const nativeToString = Function.prototype.toString;
// holders a key takes before one is read (the page can hand some over too)
const MAX_HOLDERS = 4;
// the bundle's own, taken when it loads: a ref made by another realm's
// WeakRef would keep that realm alive
const NativeWeakRef = WeakRef;
const weakDeref = WeakRef.prototype.deref;
const holderOf = (ref: WeakRef<Function>) =>
	Reflect.apply(weakDeref, ref, []) as Function | undefined;
// (a holder's text is a part of its script's own source, which its realm
// keeps: only a text kept as it was handed over is the table's own)
const unitsOf = (entry: Kept) =>
	entry.subs === undefined ? (entry.text?.length ?? 0) : 0;

/** the entry of `key`, now the newest used, wherever it is */
function find(key: string): Kept | undefined {
	let entry = kept.get(key);
	if (entry) {
		kept.delete(key);
		kept.set(key, entry);
		return entry;
	}
	const ref = fallen.get(key);
	entry = ref && (Reflect.apply(weakDeref, ref, []) as Kept | undefined);
	if (!entry) return undefined;
	fallen.delete(key);
	hold(key, entry);
	return entry;
}

/** put `entry` in the table as its newest */
function hold(key: string, entry: Kept) {
	kept.set(key, entry);
	keptUnits += unitsOf(entry);
	trim(key);
}

/** let the oldest used go while the table is past its limits */
function trim(newest: string) {
	if (kept.size <= MAX_KEPT && keptUnits <= KEPT_UNITS) return;
	// (the newest stays even past the limit)
	for (const key of kept.keys()) {
		if (key === newest || (kept.size <= MAX_KEPT && keptUnits <= KEPT_UNITS))
			break;
		const entry = kept.get(key)!;
		kept.delete(key);
		keptUnits -= unitsOf(entry);
		if (!entry.pinned) continue;
		fallen.set(key, new NativeWeakRef(entry));
		if (fallen.size <= sweepAt) continue;
		// (the keys of entries whose pins are all gone)
		for (const [gone, ref] of [...fallen.entries()])
			if (!Reflect.apply(weakDeref, ref, [])) fallen.delete(gone);
		sweepAt = Math.max(MAX_KEPT, fallen.size * 2);
	}
}

/** keep `entry` for as long as `owner` lives */
function pin(owner: object, entry: Kept) {
	pins.set(owner, entry);
	entry.pinned = true;
}

/**
 * Run `make` (a rewrite): the texts it keeps are kept for as long as
 * `owner` lives (the script element they are the text of)
 */
export function keptBy<T>(owner: object, make: () => T): T {
	const was = keeper;
	keeper = owner;
	try {
		return make();
	} finally {
		keeper = was;
	}
}

/**
 * Keep the text of the script that made a function the page was handed
 * (eval's value, new Function's) for as long as the function lives
 */
export function keepFunction(fn: unknown) {
	if (typeof fn !== 'function') return;
	try {
		originalSource(Reflect.apply(nativeToString, fn, []), fn);
	} catch (error) {
		// (a function whose source cannot be read keeps nothing)
	}
}

/**
 * Keep a script's text the inject rewrote (it rewrote that very text), for
 * as long as `owner` lives when one is given (the element whose handler
 * attribute it is)
 */
export function keepSource(key: string, text: string, owner = keeper) {
	if (report) return report(key, text);
	let entry = find(key);
	if (!entry) hold(key, (entry = { text }));
	else if (entry.text === undefined) {
		entry.text = text;
		entry.subs = entry.holders = undefined;
		keptUnits += text.length;
		trim(key);
	}
	if (owner) pin(owner, entry);
}

/**
 * Keep a script's text the service worker wrote into it (`$s$j.src`). The
 * page can call this too, which never changes how a script's functions
 * read: a function marked with a key exists only once the script ran and
 * handed its own holder over, so a key with one holder has the script's,
 * and of several the one whose text hashes to the key is believed (once,
 * when a function of the script is first read: 50 ms for 13 MB). True
 * when it took the holder, which it holds weakly: the caller keeps it
 */
export function keepEmbedded(
	key: unknown,
	subs: unknown,
	holder: unknown,
): boolean {
	if (
		typeof key !== 'string' ||
		typeof subs !== 'string' ||
		subs.length !== CARRIED.length ||
		typeof holder !== 'function'
	)
		return false;
	let entry = find(key);
	if (!entry) hold(key, (entry = {}));
	if (entry.text !== undefined) {
		// (the text another realm's holder carried, kept while this realm
		// keeps its own)
		pin(holder, entry);
		return true;
	}
	// (the holders of realms that are gone make room)
	const live: [WeakRef<Function>, string][] = [];
	for (const held of entry.holders ?? [])
		if (holderOf(held[0])) live.push(held);
	const took = live.length < MAX_HOLDERS;
	if (took) {
		live.push([new NativeWeakRef(holder), subs]);
		pin(holder, entry);
	}
	entry.holders = live;
	return took;
}

/** the key of a holder's text, its stand-ins read as what they stand for */
function encodedKey(encoded: string, subs: string): string {
	// (stand-ins past ASCII, which the key's map does not reach)
	for (let i = 0; i < CARRIED.length; i++)
		if (subs.charCodeAt(i) >= 128) return sourceKey(decode(encoded, subs));
	const map: number[] = [];
	for (let i = 0; i < 128; i++) map.push(i);
	for (let i = 0; i < CARRIED.length; i++)
		map[subs.charCodeAt(i)] = CARRIED[i]!.charCodeAt(0);
	return sourceKey(encoded, map);
}

function textOf(key: string, entry: Kept): string | null {
	const contested = (entry.holders?.length ?? 0) > 1;
	while (entry.text === undefined && entry.holders?.length) {
		const [ref, subs] = entry.holders.shift()!;
		const holder = holderOf(ref);
		// a holder of a realm that is gone, whose functions are gone with it
		if (!holder) continue;
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

/**
 * The text kept by `key`, and what its stand-ins stand for when a holder
 * carried it (the line ends among them: `subs[2]` to `subs[5]` are LF, CR,
 * LS and PS), or null (./inject/positionMaps.ts)
 */
export function keptText(key: string): [string, string | undefined] | null {
	const entry = find(key);
	const text = entry ? textOf(key, entry) : null;
	return text === null ? null : [text, entry!.subs];
}

/** a function's own source, as the browser reads it (no page's hook) */
export const nativeSource = (fn: Function): string =>
	Reflect.apply(nativeToString, fn, []);

function decode(text: string, subs: string | undefined): string {
	if (subs === undefined) return text;
	for (let i = 0; i < CARRIED.length; i++)
		if (text.includes(subs[i]!)) text = text.replaceAll(subs[i]!, CARRIED[i]!);
	return text;
}

const MARK = /\/\*([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\*\//y;

/**
 * What a function of a script whose text is not kept reads as (one the
 * table let go, nothing pinning it): its own source without the marks of
 * its script, the page's own where the rewriter changed nothing in it
 */
const unmarked = (native: string, key: string) =>
	native.replaceAll(
		new RegExp(`/\\*${key}\\.[0-9a-z]+\\.[0-9a-z]+\\*/`, 'g'),
		'',
	);
// the browser's wrapper of a handler attribute's body
const HANDLER = /^function [^\s(]*\([^)]*\) \{\n\/\*([0-9a-z]+)\*\//;

/**
 * The source a function's native source (the rewriter's output) stands
 * for, or null when it carries no mark (one whose script's text this realm
 * does not keep reads without its marks, unmarked). A mark comes after
 * the first token, with nothing that holds a comment before it but a quoted
 * method or pattern key: the scan skips strings and gives up at anything a
 * mark never follows (an `=`, a `;`, a `}`), so a function the rewriter
 * made itself, which has none, never reads as the first page function
 * nested in it. The text read is kept for as long as `fn`, the function,
 * lives.
 */
export function originalSource(native: string, fn?: Function): string | null {
	const handler = HANDLER.exec(native);
	if (handler) {
		if (!native.endsWith('\n}')) return null;
		const entry = find(handler[1]!);
		if (!entry) return null;
		const text = textOf(handler[1]!, entry);
		if (text === null) return null;
		if (fn) pin(fn, entry);
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
			const entry = find(mark[1]!);
			const text = entry ? textOf(mark[1]!, entry) : null;
			if (!entry || text === null) return unmarked(native, mark[1]!);
			if (fn) pin(fn, entry);
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
