/**
 * Who holds a copy of what a stamp versions. The Cookies and Storage
 * modules keep copies of the jar and of each store, checked against a stamp
 * in the proxy origin's own localStorage, which a write by any document
 * changes. Each change of the stamp is a storage event in every document of
 * the proxy origin that listens for one, and every document STomp runs in
 * listens (the Storage module drops them before the page sees them):
 * apnews.com wrote 824 stamps in 40 s, 41,000 events in its documents,
 * when 740 of those stamps versioned a copy only the writer's own realm held.
 *
 * So a realm says it holds a copy before it takes one, in a list of realms
 * next to the stamp, and a write stamps only when a realm other than the
 * writer's is on it. The writer's own copy has its write applied already
 * (its documents share it). A realm takes itself off when its document goes
 * away (pagehide), and drops its copies then, since the page may come back
 * from the back/forward cache to stamps it never heard. A realm that never
 * left (a crash) stays on the list, which only costs the stamps it always
 * cost; past MOST realms the list says MANY for good.
 *
 * A realm that left stays off until its document shows again (pageshow, from
 * the back/forward cache): the page's own pagehide and unload listeners run
 * after the realm's and read the store, and a read that put the realm back
 * on the list left it there for good. Every reload of YouTube added one, so
 * the next document's every localStorage write was a synchronous round trip
 * (unheld). Until it shows, it keeps no copy (`hold` says false).
 */

import { LazyMap, LazySet } from '../ownCollections';
import { addDocumentOpenListener } from './Client';

const nativeAddListener = EventTarget.prototype.addEventListener;

/** this realm (one evaluation of the bundle, shared by its about:blank documents) */
const REALM = Math.random().toString(36).slice(2, 10);
const MANY = '*';
const MOST = 16;

/** the proxy origin's own localStorage and its native members */
export interface StampStore {
	storage: Storage;
	getItem: Storage['getItem'];
	setItem: Storage['setItem'];
	removeItem: Storage['removeItem'];
}

const listOf = (key: string) => `$stomp$held:${key}`;
/** the stamp keys this realm is on the list of, and where */
const held = new LazyMap<string, StampStore>();
/** what drops this realm's copies when it leaves the lists */
const droppers = new LazySet<() => void>();

const read = (store: StampStore, key: string) =>
	(Reflect.apply(store.getItem, store.storage, [listOf(key)]) as
		string | null) ?? '';

let leaving = false;
/** this realm left the lists and its document has not shown again */
let gone = false;
/** off every list, every copy dropped */
const leave = () => {
	gone = true;
	for (const [key, store] of held.entries())
		try {
			const value = read(store, key);
			if (value === MANY) continue;
			const ids = value.split(' ').filter((id) => id && id !== REALM);
			if (ids.length)
				Reflect.apply(store.setItem, store.storage, [
					listOf(key),
					ids.join(' '),
				]);
			else Reflect.apply(store.removeItem, store.storage, [listOf(key)]);
		} catch (error) {
			// no storage now: the list keeps this realm, which costs stamps only
		}
	held.clear();
	for (const drop of droppers.values()) drop();
};

/** `drop` empties this realm's copies (when it leaves the lists) */
export function onLeave(drop: () => void) {
	droppers.add(drop);
	if (leaving) return;
	leaving = true;
	// the realm's own window (an about:blank document runs its creator's
	// bundle, whose global this is); document.open() drops every listener on
	// the window, so it is registered again after each open
	const listen = () => {
		try {
			Reflect.apply(nativeAddListener, globalThis, ['pagehide', leave, true]);
			Reflect.apply(nativeAddListener, globalThis, [
				'pageshow',
				() => (gone = false),
				true,
			]);
		} catch (error) {
			// no window
		}
	};
	listen();
	addDocumentOpenListener(globalThis, listen);
}

/**
 * This realm is about to take a copy of what `key` versions: false when it
 * may not keep one (it left, see `gone`)
 */
export function hold(store: StampStore, key: string): boolean {
	if (gone) return false;
	if (held.has(key)) return true;
	try {
		const value = read(store, key);
		held.set(key, store);
		if (value === MANY) return true;
		const ids = value ? value.split(' ') : [];
		if (ids.includes(REALM)) return true;
		ids.push(REALM);
		Reflect.apply(store.setItem, store.storage, [
			listOf(key),
			ids.length > MOST ? MANY : ids.join(' '),
		]);
	} catch (error) {
		// no storage: the stamps are written whatever the list says
		held.delete(key);
	}
	return true;
}

/** whether a realm other than this one may hold a copy of what `key` versions */
export function othersHold(store: StampStore, key: string): boolean {
	try {
		const value = read(store, key);
		if (!value) return false;
		if (value === MANY) return true;
		return value.split(' ').some((id) => id !== REALM);
	} catch (error) {
		return true;
	}
}
