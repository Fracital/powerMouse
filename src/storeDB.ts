import { openDB, type IDBPDatabase, type OpenDBCallbacks } from 'idb';
import { storeName } from './profile';

/**
 * Open one of STomp's own IndexedDB databases in this realm's profile
 * (src/profile.ts storeName). A connection closes when the database is
 * deleted (a profile forgotten, src/controller/profiles.ts), so the
 * deletion does not wait for this realm to go; a version change of the
 * same database is the caller's `blocking` to answer, as before.
 */
export function openStoreDB<T = unknown>(
	base: string,
	version: number,
	callbacks: OpenDBCallbacks<T> = {},
): Promise<IDBPDatabase<T>> {
	const opened: Promise<IDBPDatabase<T>> = openDB<T>(storeName(base), version, {
		...callbacks,
		blocking(currentVersion, blockedVersion, event) {
			callbacks.blocking?.(currentVersion, blockedVersion, event);
			if (blockedVersion === null) opened.then((db) => db.close());
		},
	});
	return opened;
}
