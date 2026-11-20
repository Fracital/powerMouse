// The reader of the maps a rewritten script file carries of its output to
// the page's text (rust/rwjs/src/positions.rs, kept by ./positionParts.ts):
// read from the map function's own source the first time a position of
// its script is asked for, and kept as long as the function is. The
// document bundle's deferred part; a worker's bundle has it itself.

import { keptText, nativeSource } from '../functionSource';
import { LazyWeakMap } from './ownCollections';

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
	const end = source.length - TAIL.length;
	let i = HEAD.length;
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
	const past = next() + source.length;
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
