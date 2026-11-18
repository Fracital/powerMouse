// The usage behind navigator.storage.estimate() for a context's partition
// (./modules/StorageEstimate.ts): the walk of its Cache Storage bodies, its
// origin private file system's files and its IndexedDB databases. A
// deferred part of the document bundle (./dom/deferred.ts), made at a
// realm's first estimate(); the worker bundle's own (./idbSizeParts.ts).
import { DATABASE_BYTES, idbSizeParts, STORE_BYTES } from './idbSizeParts';

/** the natives StorageEstimate takes at load, before the IndexedDB and Partition modules hook them */
export interface UsageNatives {
	getDirectory?: () => Promise<FileSystemDirectoryHandle>;
	databases?: () => Promise<IDBDatabaseInfo[]>;
	openDatabase?: IDBFactory['open'];
	cacheKeys?: CacheStorage['keys'];
	cacheOpen?: CacheStorage['open'];
	entryKeys?: Cache['keys'];
	entryMatch?: Cache['match'];
	/** Object.prototype.toString (the sizing reads each value's tag with it) */
	tagOf: () => string;
}

/** values of an object store sized to estimate the rest of it */
const SAMPLE = 64;
/** a request's result, or its error */
function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * The usage of the stores the partition `key` names, by kind: its caches,
 * its file system and its IndexedDB databases (`that`: the StorageManager
 * the page called estimate() on, or the one it is redirected to)
 */
export async function storageUsage(
	natives: UsageNatives,
	global: typeof globalThis,
	that: StorageManager,
	key: string,
): Promise<[number, number, number]> {
	const {
		getDirectory,
		databases,
		openDatabase,
		cacheKeys,
		cacheOpen,
		entryKeys,
		entryMatch,
		tagOf,
	} = natives;
	const databaseUsage = async (
		idb: IDBFactory,
		key: string,
	): Promise<number> => {
		if (!databases || !openDatabase) return 0;
		const own = `@${key}`;
		let total = 0;
		for (const info of await Reflect.apply(databases, idb, [])) {
			if (!info.name?.endsWith(own)) continue;
			const request = Reflect.apply(openDatabase, idb, [
				info.name,
			]) as IDBOpenDBRequest;
			// deleted since it was listed: opening must not make it again
			request.onupgradeneeded = () => request.transaction?.abort();
			let db: IDBDatabase;
			try {
				db = await done(request);
			} catch (error) {
				continue;
			}
			total += DATABASE_BYTES;
			try {
				for (const name of db.objectStoreNames) {
					total += STORE_BYTES;
					const store = db.transaction(name, 'readonly').objectStore(name);
					const count = await done(store.count());
					if (!count) continue;
					let sampled = 0;
					let size = 0;
					await new Promise<void>((resolve, reject) => {
						const cursor = store.openCursor();
						cursor.onerror = () => reject(cursor.error);
						cursor.onsuccess = () => {
							const at = cursor.result;
							if (!at || sampled >= SAMPLE) return resolve();
							sampled++;
							size += idbSizeParts.recordSize!()(at.key, at.value, tagOf);
							at.continue();
						};
					});
					if (sampled) total += Math.round((size / sampled) * count);
				}
			} finally {
				db.close();
			}
		}
		return total;
	};

	const cacheUsage = async (
		storage: CacheStorage,
		key: string,
	): Promise<number> => {
		if (!cacheKeys || !cacheOpen || !entryKeys || !entryMatch) return 0;
		const own = `@${key}`;
		let total = 0;
		for (const name of (await Reflect.apply(
			cacheKeys,
			storage,
			[],
		)) as string[]) {
			if (!name.endsWith(own)) continue;
			const cache = (await Reflect.apply(cacheOpen, storage, [name])) as Cache;
			for (const request of (await Reflect.apply(
				entryKeys,
				cache,
				[],
			)) as readonly Request[]) {
				const response = (await Reflect.apply(entryMatch, cache, [request])) as
					Response | undefined;
				total += request.url.length;
				// a cached body is a blob already: its size is not a read
				if (response) total += (await response.blob()).size;
			}
		}
		return total;
	};

	const directoryUsage = async (
		directory: FileSystemDirectoryHandle,
		depth = 0,
	): Promise<number> => {
		let total = 0;
		if (depth > 32) return total;
		const entries = (
			directory as unknown as {
				values(): AsyncIterable<FileSystemHandle>;
			}
		).values();
		for await (const handle of entries)
			total +=
				handle.kind === 'file'
					? (await (handle as FileSystemFileHandle).getFile()).size
					: await directoryUsage(
							handle as FileSystemDirectoryHandle,
							depth + 1,
						);
		return total;
	};

	const fileSystemUsage = async (
		that: StorageManager,
		key: string,
	): Promise<number> => {
		if (typeof getDirectory !== 'function') return 0;
		const root = (await Reflect.apply(
			getDirectory,
			that,
			[],
		)) as FileSystemDirectoryHandle;
		let own: FileSystemDirectoryHandle;
		try {
			own = await root.getDirectoryHandle(encodeURIComponent(key));
		} catch (error) {
			// nothing stored yet
			return 0;
		}
		return directoryUsage(own);
	};

	/** one store's usage; a store this context cannot use counts nothing */
	const settled = async (usage: () => Promise<number>) => {
		try {
			return await usage();
		} catch (error) {
			return 0;
		}
	};

	const idb = (global as { indexedDB?: IDBFactory }).indexedDB;
	const storage = (global as { caches?: CacheStorage }).caches;
	return Promise.all([
		storage ? settled(() => cacheUsage(storage, key)) : 0,
		settled(() => fileSystemUsage(that, key)),
		idb ? settled(() => databaseUsage(idb, key)) : 0,
	]);
}
