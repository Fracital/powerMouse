import Client from '../Client';
import { DATABASE_BYTES, recordSize, STORE_BYTES } from '../idbSize';
import Module from '../Module';
import ProxyModule from './Proxy';

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
 * navigator.storage.estimate() for the proxied origin's partition alone.
 * The browser keeps one quota for the proxy origin, so its own answer
 * counts every proxied site's stores (a megabyte another site stored shows
 * in this one's) and Stomp's caches; natively a page sees its storage
 * key's usage only. The usage here is that of the stores this context's
 * key names (src/partition.ts): its Cache Storage bodies, its origin
 * private file system's files and its IndexedDB databases, their records
 * sampled per object store and sized as Chrome counts them on disk (the
 * overheads and the compression of large values measured, src/inject/
 * idbSize.ts). The quota keeps what the browser has left for the
 * proxy origin, as natively a quota is the usage plus what is left.
 * localStorage is not counted, as Chrome does not count it.
 */
export default class StorageEstimateModule extends Module<Client> {
	apply() {
		const global = this.client.global;
		if (typeof global.StorageManager !== 'function') return;
		const manager = global.StorageManager.prototype;
		const estimate = manager.estimate;
		if (typeof estimate !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		// the native members, before the IndexedDB and Partition modules hook
		// them: the stores' real names carry the key
		const getDirectory = manager.getDirectory;
		const factory = global.IDBFactory?.prototype as
			| (IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> })
			| undefined;
		const databases = factory?.databases;
		const openDatabase = factory?.open;
		const cacheKeys = global.CacheStorage?.prototype.keys;
		const cacheOpen = global.CacheStorage?.prototype.open;
		const entryKeys = global.Cache?.prototype.keys;
		const entryMatch = global.Cache?.prototype.match;

		const suffix = () => `@${this.client.storageKey}`;

		const databaseUsage = async (idb: IDBFactory): Promise<number> => {
			if (!databases || !openDatabase) return 0;
			const own = suffix();
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
								size += recordSize(at.key, at.value);
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

		const cacheUsage = async (storage: CacheStorage): Promise<number> => {
			if (!cacheKeys || !cacheOpen || !entryKeys || !entryMatch) return 0;
			const own = suffix();
			let total = 0;
			for (const name of (await Reflect.apply(
				cacheKeys,
				storage,
				[],
			)) as string[]) {
				if (!name.endsWith(own)) continue;
				const cache = (await Reflect.apply(cacheOpen, storage, [
					name,
				])) as Cache;
				for (const request of (await Reflect.apply(
					entryKeys,
					cache,
					[],
				)) as readonly Request[]) {
					const response = (await Reflect.apply(entryMatch, cache, [
						request,
					])) as Response | undefined;
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

		const fileSystemUsage = async (that: StorageManager): Promise<number> => {
			if (typeof getDirectory !== 'function') return 0;
			const root = (await Reflect.apply(
				getDirectory,
				that,
				[],
			)) as FileSystemDirectoryHandle;
			let own: FileSystemDirectoryHandle;
			try {
				own = await root.getDirectoryHandle(
					encodeURIComponent(this.client.storageKey),
				);
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

		manager.estimate = proxyModule.wrapFunction(
			estimate,
			async (target, that, args) => {
				const real = (await Reflect.apply(
					target,
					that,
					args,
				)) as StorageEstimate;
				const idb = (global as { indexedDB?: IDBFactory }).indexedDB;
				const storage = (global as { caches?: CacheStorage }).caches;
				const [caches, fileSystem, indexedDB] = await Promise.all([
					storage ? settled(() => cacheUsage(storage)) : 0,
					settled(() => fileSystemUsage(that as StorageManager)),
					idb ? settled(() => databaseUsage(idb)) : 0,
				]);
				const usage = caches + fileSystem + indexedDB;
				// the dictionary's members in Chrome's order, only those in use
				const usageDetails: Record<string, number> = {};
				if (caches) usageDetails.caches = caches;
				if (fileSystem) usageDetails.fileSystem = fileSystem;
				if (indexedDB) usageDetails.indexedDB = indexedDB;
				const left = Math.max(0, (real.quota ?? 0) - (real.usage ?? 0));
				return { quota: left + usage, usage, usageDetails };
			},
		) as StorageManager['estimate'];
	}
}
