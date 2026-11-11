// The media loads that came through another origin. A video or sound the
// page's own origin redirects to another site is that site's to the page (a
// canvas that draws it is tainted, Web Audio hears silence, it cannot be
// captured), and the element says only its first URL. The mark the inject
// reads for an image (OPAQUE_MARKER, in resource timing) is there once the
// load is over, and a media load is over when the last byte has come, which
// for a stream is never: the inject asks here instead, over the synchronous
// bridge, the first time it has to judge an element that has data.
//
// Only the loads that crossed are kept, by the first routed URL of their
// chain, before their answer goes out: what is not here did not cross. They
// are kept in IndexedDB too, since Chrome stops an idle service worker while
// the element plays on from what it has.
import { IDBPDatabase, openDB } from 'idb';
import type Router from './Router';
import { jsonAPI } from './Router';

const KEPT = 2048;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;

const crossed = new Set<string>();
let pruned = Date.now();

let database: Promise<IDBPDatabase> | null = null;
function store(): Promise<IDBPDatabase> {
	database ??= openDB('stompMediaLoads', 1, {
		upgrade(db) {
			db.createObjectStore('crossed');
		},
	});
	return database;
}

const keyOf = (url: string) => url.split('#')[0];

async function prune() {
	pruned = Date.now();
	try {
		const db = await store();
		const tx = db.transaction('crossed', 'readwrite');
		let cursor = await tx.store.openCursor();
		let count = 0;
		while (cursor) {
			if (Date.now() - (cursor.value as number) > KEPT_MS)
				await cursor.delete();
			else count++;
			cursor = await cursor.continue();
		}
		await tx.done;
		if (count > KEPT) {
			const keys = await db.getAllKeys('crossed', null, count - KEPT);
			for (const key of keys) await db.delete('crossed', key);
		}
	} catch (error) {
		// no store: memory only
	}
}

/** a media load whose chain began at the routed URL `first` came through another origin */
export async function recordCrossedMedia(first: string) {
	const key = keyOf(first);
	if (crossed.has(key)) return;
	crossed.add(key);
	if (crossed.size > KEPT) crossed.delete(crossed.values().next().value!);
	try {
		await (await store()).put('crossed', Date.now(), key);
	} catch (error) {
		// no store: memory only
	}
	if (Date.now() - pruned > PRUNE_EVERY_MS) void prune();
}

/** whether a media load that began at the routed URL `first` came through another origin */
export async function mediaCrossed(first: string): Promise<boolean> {
	const key = keyOf(first);
	if (crossed.has(key)) return true;
	try {
		if ((await (await store()).get('crossed', key)) === undefined) return false;
	} catch (error) {
		return false;
	}
	crossed.add(key);
	return true;
}

/** the page-facing route: the inject asks by the URL its element has */
export function registerMediaLoads(router: Router) {
	router.routes.set(
		/^\/media\/crossed$/,
		jsonAPI((first: string) => mediaCrossed(String(first))),
	);
}
