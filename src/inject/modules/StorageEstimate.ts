import Client from '../Client';
import { DATABASE_BYTES, idbSizeParts, STORE_BYTES } from '../idbSizeParts';
import Module from '../Module';
import { redirected, storageRedirects } from '../storageRedirect';
import ProxyModule from './Proxy';

/** values of an object store sized to estimate the rest of it */
const SAMPLE = 64;
// taken before the page runs (the sizing reads each value's tag with it)
const tagOf = Object.prototype.toString;
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
 * in this one's) and STomp's caches; natively a page sees its storage
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
		const client = this.client;
		const global = client.global;
		if (typeof global.StorageManager !== 'function') return;
		const manager = global.StorageManager.prototype;
		const estimate = manager.estimate;
		if (typeof estimate !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;
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

		manager.estimate = proxyModule.wrapFunction(
			estimate,
			async (target, receiver, args) => {
				// (a Storage Access handle's is the first-party key's, and
				// natively details nothing)
				const handle = storageRedirects.has(receiver);
				const [that, key] = redirected(receiver, client.storageKey);
				const real = (await Reflect.apply(
					target,
					that,
					args,
				)) as StorageEstimate;
				const idb = (global as { indexedDB?: IDBFactory }).indexedDB;
				const storage = (global as { caches?: CacheStorage }).caches;
				const [caches, fileSystem, indexedDB] = await Promise.all([
					storage ? settled(() => cacheUsage(storage, key)) : 0,
					settled(() => fileSystemUsage(that, key)),
					idb ? settled(() => databaseUsage(idb, key)) : 0,
				]);
				const usage = caches + fileSystem + indexedDB;
				// the dictionary's members in Chrome's order, only those in use
				const usageDetails: Record<string, number> = {};
				if (caches && !handle) usageDetails.caches = caches;
				if (fileSystem && !handle) usageDetails.fileSystem = fileSystem;
				if (indexedDB && !handle) usageDetails.indexedDB = indexedDB;
				const left = Math.max(0, (real.quota ?? 0) - (real.usage ?? 0));
				return { quota: left + usage, usage, usageDetails };
			},
		) as StorageManager['estimate'];

		// navigator.webkitTemporaryStorage and webkitPersistentStorage report
		// the usage and quota estimate() does (measured in Chrome 157): the
		// origin's, so this context's partition's here. The browser checks
		// the arguments and answers first; its answer is then replaced, and a
		// grant is never more than this partition's quota. Reading either
		// object at load would make it and its interface in every frame
		// (about 9 KB of heap a frame, measured with the frame-cost suite),
		// so its members are hooked at the first read of either, before the
		// getter hands the page the object.
		const ownEstimate = manager.estimate;
		const navigator = Reflect.getPrototypeOf(global.navigator) as object;
		const storageOf = Reflect.getOwnPropertyDescriptor(
			navigator,
			'storage',
		)?.get;
		const answer =
			(
				that: unknown,
				success: unknown,
				answer: (estimate: StorageEstimate, granted: number) => number[],
			) =>
			(granted: number) =>
				Reflect.apply(
					ownEstimate,
					Reflect.apply(storageOf!, that, []),
					[],
				).then((estimate: StorageEstimate) =>
					Reflect.apply(
						success as Function,
						undefined,
						answer(estimate, granted),
					),
				);
		let hooked = false;
		const hook = (deprecated: object, owner: unknown) => {
			hooked = true;
			const quotas = Reflect.getPrototypeOf(deprecated) as Record<
				string,
				Function
			>;
			for (const [name, at] of [
				['queryUsageAndQuota', 0],
				['requestQuota', 1],
			] as const)
				quotas[name] = proxyModule.wrapFunction(
					quotas[name],
					(target, that, args) => {
						if (typeof args[at] === 'function')
							args[at] = answer(owner, args[at], (estimate, granted) =>
								at
									? [Math.min(granted, estimate.quota!)]
									: [estimate.usage!, estimate.quota!],
							);
						return Reflect.apply(target, that, args);
					},
				);
		};
		if (storageOf)
			for (const name of [
				'webkitTemporaryStorage',
				'webkitPersistentStorage',
			]) {
				const descriptor = Reflect.getOwnPropertyDescriptor(navigator, name);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(navigator, name, {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const deprecated = Reflect.apply(target, that, args);
							if (!hooked && deprecated) hook(deprecated, that);
							return deprecated;
						},
					),
				});
			}
	}
}
