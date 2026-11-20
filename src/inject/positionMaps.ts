// The reader of the maps a rewritten script file carries of its output to
// the page's text (rust/rwjs/src/positions.rs, kept by ./positionParts.ts):
// read from the map function's own source the first time a position of
// its script is asked for, and kept as long as the function is. And of the
// maps of code the inject rewrote, handed over apart (placeCode), found by
// the hash V8 names a frame's script by. The document bundle's deferred
// part; a worker's bundle has it itself.

import { keptText, nativeSource } from '../functionSource';
import { sha256Hex } from '../sha';
import { LazyMap, LazyWeakMap } from './ownCollections';
import { heldCodes, type CodeMap, type Place } from './positionParts';

/** a map read: the stretches of the output and the lines of the text */
interface Read {
	/** where the text ahead of the script's code starts in the output, and where it ends */
	at: number;
	past: number;
	/** the text's position that text stands at */
	stands: number;
	/** each stretch of the output without that text: its start, and where it stands (text) or starts (a copy) in the source */
	outs: number[];
	srcs: number[];
	texts: boolean[];
	/** where each line of the source starts, once known */
	lines?: number[];
	/** the output's length */
	length: number;
	/** the text's key, to read its lines from where they are not in the map */
	key: string;
}

const DIGITS =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEAD = 'function(){/*';
const TAIL = '*/}';
const read = new LazyWeakMap<Function, Read>();

/** the map in `map`'s source, read */
function readMap(key: string, map: Function): Read {
	const source = nativeSource(map);
	return readText(
		source,
		HEAD.length,
		source.length - TAIL.length,
		source.length,
		key,
	);
}

/**
 * the map in `source` from `i` to `end`, `own` the length its first number
 * leaves out (the function it is in, or 0 for one handed over apart)
 */
function readText(
	source: string,
	i: number,
	end: number,
	own: number,
	key: string,
): Read {
	// a base64 VLQ number (edits::push_vlq)
	const next = () => {
		let value = 0;
		let scale = 1;
		let digit;
		do {
			digit = DIGITS.indexOf(source[i++]!);
			value += (digit & 31) * scale;
			scale *= 32;
		} while (digit & 32);
		return value;
	};
	const past = next() + own;
	const at = next();
	const stands = next();
	const done: Read = {
		at,
		past,
		stands,
		outs: [],
		srcs: [],
		texts: [],
		key,
		length: 0,
	};
	const count = next();
	if (count) {
		const lines = [0];
		for (let line = 1; line < count; line++)
			lines[line] = lines[line - 1]! + next();
		done.lines = lines;
	}
	let out = 0;
	let ended = 0;
	for (let run = 0; i < end; run++) {
		const length = next();
		const packed = next();
		const text = packed % 2 === 1;
		const delta = Math.floor(packed / 2);
		const src = ended + (delta % 2 ? -(delta + 1) / 2 : delta / 2);
		done.outs[run] = out;
		done.srcs[run] = src;
		done.texts[run] = text;
		out += length;
		ended = text ? src : src + length;
	}
	done.length = out + past - at;
	return done;
}

/** where each line of a kept text starts (LF, CR, CRLF, LS and PS end one) */
function lineStarts(key: string): number[] {
	const kept = keptText(key);
	if (!kept) return [0];
	const [text, subs] = kept;
	const [lf, cr, ls, ps] = subs
		? [subs[2], subs[3], subs[4], subs[5]]
		: ['\n', '\r', ' ', ' '];
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === cr && text[i + 1] === lf) i++;
		else if (c !== lf && c !== cr && c !== ls && c !== ps) continue;
		starts[starts.length] = i + 1;
	}
	return starts;
}

/** the last index of `list` (ascending) whose value is at most `value` */
function lastAtMost(list: number[], value: number): number {
	let low = 0;
	let high = list.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (list[middle]! <= value) low = middle;
		else high = middle - 1;
	}
	return low;
}

/**
 * Where position `at` of the output of the script whose map is `map`
 * stands in its text (kept by `key`, or '' when the map has its lines):
 * the offset, line and column (from 1)
 */
export function placeIn(
	key: string,
	map: Function,
	at: number,
): [number, number, number] {
	let known = read.get(map);
	if (!known) read.set(map, (known = readMap(key, map)));
	return placeRead(known, at);
}

/** where position `at` of an output stands in its text, by its map read */
function placeRead(known: Read, at: number): [number, number, number] {
	let offset: number;
	if (at >= known.at && at < known.past) offset = known.stands;
	else {
		const inside = at < known.at ? at : at - (known.past - known.at);
		const run = lastAtMost(known.outs, inside);
		offset = known.texts[run]
			? known.srcs[run]!
			: known.srcs[run]! + inside - known.outs[run]!;
	}
	const lines = (known.lines ??= lineStarts(known.key));
	const line = lastAtMost(lines, offset);
	return [offset, line + 1, offset - lines[line]! + 1];
}

/**
 * The maps of code the inject rewrote by the SHA-256 (hex) of the script V8
 * runs, which a frame's script is named by (the same script again is
 * one): those ./positionParts.ts keepCode held, filed here when a frame of
 * no file is placed. The newest 4096 are kept.
 */
export const codes = new LazyMap<string, CodeMap>();

/**
 * Where position `at` of a frame's script (`site`, V8's) stands in the page's text, where that script
 * is code the inject rewrote and kept the map of (./positionParts.ts
 * keepCode): the offset, line and column, the line counted from where the
 * code stands in the document and its first line's column from where that
 * line starts there, then the line and column within the code
 */
export function placeCode(site: object, at: unknown): Place | null {
	const frame = site as { getScriptHash?(): unknown };
	const hash = typeof at === 'number' ? frame.getScriptHash?.() : undefined;
	if (typeof hash !== 'string') return null;
	// (the codes held since the last frame of no file are hashed now)
	if (!codes.has(hash))
		for (const [key, code] of [...heldCodes.entries()]) {
			heldCodes.delete(key);
			const { head = '', tail = '' } = code[1];
			const hex = sha256Hex(head + code[2] + tail);
			code[2] = undefined;
			if (codes.has(hex)) continue;
			codes.set(hex, code);
			if (codes.size > 4096) codes.delete(codes.keys().next().value!);
		}
	const code = codes.get(hash);
	return code ? placeKept(code, at as number) : null;
}

/** a frame of the stack the page reads, as Unroute.ts reads it */
interface Frame {
	getLineNumber(): number | null | undefined;
	getColumnNumber(): number | null | undefined;
	getPosition?(): number;
}

/**
 * An eval's frame `text` with its origin placed: V8 names the place of the
 * call that ran the code in that call's script (a script of the markup by
 * no name), which is the frame below's (`below`, of the script named
 * `name`), on its line where it is the call; `placed` places a position of
 * the frame below's script (Unroute.ts)
 */
export function placeOrigin<F extends Frame>(
	text: string,
	below: F,
	name: string | null | undefined,
	placed: (site: F, at: number) => Place | null,
): string {
	const line = below.getLineNumber();
	const column = below.getColumnNumber();
	const position = below.getPosition?.();
	const origin = new RegExp(
		`\\((${name?.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&') ?? ''})?:${line}:(\\d+)\\)`,
	).exec(text);
	if (!origin || typeof position !== 'number' || typeof column !== 'number')
		return text;
	const caller = placed(below, position + +origin[2]! - column);
	return caller
		? `${text.slice(0, origin.index)}(${name}:${caller[3] ?? caller[1]}:${caller[4] ?? caller[2]})${text.slice(origin.index + origin[0].length)}`
		: text;
}

/**
 * Where position `at` of the output of kept code `code` stands in the
 * page's text (placeCode), or null past the output's end
 */
export function placeKept(code: CodeMap, at: number): Place | null {
	const map = code[0];
	const known = (code[3] ??= readText(map, 0, map.length, 0, '')) as Read;
	const [before, start] = code[1].place ?? [0, 0];
	const head = code[1].head?.length ?? 0;
	if (at - head >= known.length) return null;
	const [offset, line, column] = placeRead(known, Math.max(at - head, 0));
	return [
		offset,
		before + line,
		line === 1 ? start + column : column,
		line,
		column,
	];
}

/** the readers, as ./positionParts.ts asks for them */
export const readers = { file: placeIn, code: placeCode, origin: placeOrigin };
