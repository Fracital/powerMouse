// The maps the service worker's rewrites of script files carry, of each
// output to the page's text (rust/rwjs/src/positions.rs), kept by the
// script's URL as the page knows it: a stack frame, a long animation frame's
// script and a violation's place name where in the page's own text a
// position of the output stands, as natively. A script hands its map over
// as it starts (`$s$j.pos`); it is read by ./positionMaps.ts, the document
// bundle's deferred part (a worker's bundle has it itself), the first time
// a position of that script is asked for.

import type { placeIn } from './positionMaps';

/** the reader (./positionMaps.ts), as each bundle has it */
export const positionParts: { read?: () => typeof placeIn } = {};

// the bundle's own, taken when it loads: a ref made by another realm's
// WeakRef would keep that realm alive
const NativeWeakRef = WeakRef;
const weakDeref = WeakRef.prototype.deref;
/** each script URL's map: the key of its text's holder, and the function the map is in */
const maps = new Map<string, [string, WeakRef<Function>]>();

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
 * Where position `at` (UTF-16 units from the start) of the output of the
 * script at `url` stands in the page's text: its offset, line and column
 * (from 1), or null where no map says (a script the inject rewrote, no
 * map kept, no reader to be had)
 */
export function placeOf(
	url: unknown,
	at: unknown,
): [number, number, number] | null {
	const held = typeof url === 'string' ? maps.get(url) : undefined;
	if (!held || typeof at !== 'number') return null;
	try {
		// (a map of a realm that is gone, whose frames are gone with it)
		const map = Reflect.apply(weakDeref, held[1], []) as Function | undefined;
		return map ? (positionParts.read?.()(held[0], map, at) ?? null) : null;
	} catch (error) {
		return null;
	}
}
