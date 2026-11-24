// The maps the service worker's rewrites of script files carry, of each
// output to the page's text (rust/rwjs/src/positions.rs), kept by the
// script's URL as the page knows it: a stack frame, a long animation frame's
// script and a violation's place name where in the page's own text a
// position of the output stands, as natively. A script hands its map over
// as it starts (`$s$j.pos`); it is read by ./positionMaps.ts, the document
// bundle's deferred part (a worker's bundle has it itself), the first time
// a position of that script is asked for. Code the inject rewrote has no
// URL to be kept by: the map its rewrite hands over is kept here (keepCode)
// and found by the hash V8 names its script by (positionMaps.ts placeCode).

import type { ScriptSource } from '../rewriteJS';
import { LazyMap } from './ownCollections';
import type { readers } from './positionMaps';

/** the readers (./positionMaps.ts), as each bundle has them */
export const positionParts: {
	maps?: () => typeof readers;
} = {};

/**
 * The maps of code the inject rewrote (an inline script, a handler, eval, a
 * string timer), which carries none, as its rewrite handed each over
 * (src/wasm/rewriter.ts takeApart), with the script V8 runs: held, the
 * newest 4096 and no more than HELD_UNITS of output, until a frame of no
 * file is first placed, when the reader files them by the hash V8 names a
 * frame's script by (./positionMaps.ts placeCode)
 */
export const heldCodes = new LazyMap<number, CodeMap>();
let kept = 0;
/**
 * The most output the held codes keep, in UTF-16 units (64 MB). Each keeps
 * its whole script until it is hashed, and a page that runs one large script
 * again and again (Cloudflare Turnstile retrying its challenge) would hold
 * 4096 copies of it
 */
const HELD_UNITS = 32 * 1024 * 1024;
let heldUnits = 0;

/**
 * Whether this engine names a stack frame's script by its hash (V8's
 * CallSite getScriptHash), the one thing a held code is found by. Asked
 * once, as the bundle loads, before any script of the page's runs:
 * SpiderMonkey and JavaScriptCore never call Error.prepareStackTrace, so
 * there a held code could never be read, and none is kept
 */
const namesScripts = (() => {
	const ErrorCtor = Error as ErrorConstructor & { prepareStackTrace?: unknown };
	const had = Reflect.getOwnPropertyDescriptor(ErrorCtor, 'prepareStackTrace');
	let found = false;
	try {
		Reflect.defineProperty(ErrorCtor, 'prepareStackTrace', {
			configurable: true,
			writable: true,
			value: (error: unknown, sites: unknown) => {
				const site = Array.isArray(sites) ? sites[0] : undefined;
				found =
					typeof (site as { getScriptHash?: unknown } | undefined)
						?.getScriptHash === 'function';
				return '';
			},
		});
		void new ErrorCtor().stack;
	} catch (error) {
		// (a realm that refuses the property: no V8 here to read it)
	} finally {
		if (had) Reflect.defineProperty(ErrorCtor, 'prepareStackTrace', had);
		else Reflect.deleteProperty(ErrorCtor, 'prepareStackTrace');
	}
	return found;
})();
/** a code's map, what the script V8 runs has around the output and where it stands, the output until hashed, then the reader's */
export type CodeMap = [
	map: string,
	source: ScriptSource,
	output: string | undefined,
	read?: unknown,
	/** a written script's hash once the browser has digested it */
	hash?: string,
];

/** code whose rewrite's map its caller keeps, with the script it makes of the output */
export const MAPPED: ScriptSource = {};

/**
 * Keep the map of code the inject rewrote (`map` as its rewrite handed it
 * over, '' for none), whose output is in the script V8 runs between
 * `source`'s head and tail
 */
export function keepCode(
	map: string | undefined,
	source: ScriptSource = MAPPED,
	output: string,
) {
	if (!map || !namesScripts) return;
	const code: CodeMap = [map, source, output, undefined, undefined];
	heldCodes.set(++kept, code);
	heldUnits += output.length;
	const dropped = heldCodes.get(kept - 4096);
	if (dropped) {
		heldUnits -= dropped[2]?.length ?? 0;
		heldCodes.delete(kept - 4096);
	}
	if (heldUnits > HELD_UNITS) {
		// (an output hashed since it was held keeps no text: count afresh)
		let units = 0;
		for (const held of [...heldCodes.values()]) units += held[2]?.length ?? 0;
		// the oldest go first, the newest staying even past the limit
		for (const [key, held] of [...heldCodes.entries()]) {
			if (units <= HELD_UNITS || key === kept) break;
			units -= held[2]?.length ?? 0;
			heldCodes.delete(key);
		}
		heldUnits = units;
	}
	return code;
}

// the bundle's own, taken when it loads: a ref made by another realm's
// WeakRef would keep that realm alive
const NativeWeakRef = WeakRef;
const weakDeref = WeakRef.prototype.deref;
/** each script URL's map: the key of its text's holder, and the function the map is in */
const maps = new LazyMap<string, [string, WeakRef<Function>]>();

/**
 * Keep the map a script hands over (the page can call this too, which
 * changes only where its own frames read as standing): true when it took
 * the function, which it holds weakly, the caller keeping it
 */
export function keepPositions(
	url: unknown,
	key: unknown,
	map: unknown,
): boolean {
	if (
		typeof url !== 'string' ||
		typeof key !== 'string' ||
		typeof map !== 'function'
	)
		return false;
	maps.set(url, [key, new NativeWeakRef(map)]);
	return true;
}

/**
 * a place in the page's text: the offset, line and column (from 1), and for
 * code the inject rewrote the line and column within the code itself, which
 * an eval's origin names
 */
export type Place = [number, number, number, number?, number?];

/**
 * Where position `at` (UTF-16 units from the start) of the output of the
 * script at `url` stands in the page's text: its offset, line and column
 * (from 1), or null where no map says (a script the inject rewrote, no
 * map kept, no reader to be had)
 */
export function placeOf(
	url: unknown,
	at: unknown,
	/** a frame's, whose script may be code the inject rewrote */
	site?: object,
): Place | null {
	const held = typeof url === 'string' ? maps.get(url) : undefined;
	try {
		if (!held)
			return site && kept
				? (positionParts.maps?.().code(site, at) ?? null)
				: null;
		// (a map of a realm that is gone, whose frames are gone with it)
		const map = Reflect.apply(weakDeref, held[1], []) as Function | undefined;
		return map && typeof at === 'number'
			? (positionParts.maps?.().file(held[0], map, at) ?? null)
			: null;
	} catch (error) {
		return null;
	}
}
