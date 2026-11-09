import { STORAGE_EVENT, StorageChange } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule, {
	catchRequiredArguments,
	contextThis,
	newConstructor,
	usePrototype,
} from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import SyncModule, { BEACON_QUOTA } from './Sync';

/**
 * Chrome's quota for a store: 5 MiB of key and value lengths, in UTF-16 code
 * units, per origin (measured in Chrome 152: a value of 5242879 characters
 * under a one-character key stores, one more throws, whatever the characters)
 */
const QUOTA = 5 * 1024 * 1024;

/**
 * The beacons in flight a write may bring the document to (the bridge counts
 * every beacon it sent, reads included); the rest of the quota is kept for
 * reads, which cannot go another way.
 */
const WRITE_BUDGET = BEACON_QUOTA - 24 * 1024;

const sizeOf = (key: string, value: string) => key.length + value.length;

/** a key's newest operation that the worker may not have yet */
interface Shadowed {
	value: string | null;
	seq: number;
}

/** a store's operations in flight from this document */
interface Pending {
	values: Map<string, Shadowed>;
	/** the newest clear in flight, before which every other key is gone */
	cleared: number | null;
	/** the number of the next operation; the worker applies them in order */
	seq: number;
	/** the numbers of those in flight */
	inflight: Set<number>;
}

export default class StorageModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const syncModule = this.client.getModule(SyncModule)!;

		const instances = new WeakSet();

		let building = true;

		const getOrigin = () => this.client.url.url.origin;
		// this document, so it never hears its own changes
		const sender = Math.random().toString(36).slice(2);
		const here = () => this.client.url.toString();

		// Every call below is a synchronous beacon to the worker, and Chrome
		// refuses a document's beacons once 64 KiB of them are in flight,
		// which frees only between tasks. Twitch reads one flag key over a
		// hundred times while it renders: the reads after the quota threw
		// QuotaExceededError (a native read never throws) and its error
		// logger, which reads a flag again, recursed until the stack
		// overflowed. So a document keeps what it read and wrote for as long
		// as a stamp in the proxy origin's own localStorage (unhooked, shared
		// by every document of the proxy origin, taken before the page gets
		// its own below) is unchanged, and every write by any document
		// changes the stamp, as the Cookies module does for the jar.
		interface ReadCache {
			store: string;
			version: string;
			values: Map<string, string | null>;
			keys: string[] | null;
			/**
			 * the origin's size once every write this document made lands, or
			 * more (never less): a write that keeps it under the quota needs
			 * no question to the worker
			 */
			usage: number | null;
		}
		const caches = new Map<string, ReadCache>();
		let stamps: Storage | null = null;
		let nativeGetItem: Storage['getItem'] | undefined;
		let nativeSetItem: Storage['setItem'] | undefined;
		try {
			const global = this.client.global;
			stamps =
				(Reflect.getOwnPropertyDescriptor(global, 'localStorage')?.get?.call(
					global,
				) as Storage | undefined) ?? null;
			nativeGetItem = global.Storage.prototype.getItem;
			nativeSetItem = global.Storage.prototype.setItem;
		} catch (error) {
			// no storage of its own (an opaque origin): every read goes out
		}
		const stampOf = (cache: ReadCache) =>
			`$stomp$${cache.store}:${getOrigin()}`;
		/** the document's copy of a store, emptied when another document wrote */
		const current = (directory: string): ReadCache | null => {
			const cache = caches.get(directory);
			if (!cache || !stamps || !nativeGetItem) return null;
			let version: string;
			try {
				version = Reflect.apply(nativeGetItem, stamps, [stampOf(cache)]) ?? '';
			} catch (error) {
				return null;
			}
			if (version !== cache.version) {
				cache.values.clear();
				cache.keys = null;
				cache.usage = null;
				cache.version = version;
			}
			return cache;
		};
		/** the store changed: every document reads it fresh */
		const stamp = (cache: ReadCache): string | null => {
			const version = `${Date.now()}:${Math.random()}`;
			try {
				Reflect.apply(nativeSetItem!, stamps, [stampOf(cache), version]);
				return version;
			} catch (error) {
				return null;
			}
		};
		/** this document wrote `key` (every key, for null) and the worker has it */
		const wrote = (
			directory: string,
			key: string | null,
			value: string | null,
		) => {
			const cache = current(directory);
			if (!cache) return;
			const version = stamp(cache);
			if (version === null) {
				cache.values.clear();
				cache.keys = null;
				return;
			}
			cache.version = version;
			if (key === null) {
				cache.values.clear();
				cache.keys = [];
				return;
			}
			cache.values.set(key, value);
			if (!cache.keys) return;
			const index = cache.keys.indexOf(key);
			if (value === null && index !== -1) cache.keys.splice(index, 1);
			else if (value !== null && index === -1) cache.keys.push(key);
		};
		/**
		 * A change this document has no copy of: read it again. `own` is one of
		 * this document's writes landing, which its size was counted for.
		 */
		const changed = (directory: string, own: boolean) => {
			const cache = caches.get(directory);
			if (!cache) return;
			cache.values.clear();
			cache.keys = null;
			if (!own) {
				cache.usage = null;
				return;
			}
			const before = current(directory);
			const version = before && stamp(before);
			if (before && version !== null) before.version = version;
		};

		// A write the synchronous bridge cannot carry is kept here as this
		// document's view of the key and sent to the worker asynchronously.
		// The bridge cannot carry a large value (its beacon is refused over
		// 64 KiB, and the quota is per document while this thread spins, so
		// no number of beacons helps), and it cannot carry a medium one once
		// the beacons this document has in flight are near the quota: Discord
		// writes several medium JSON values in one task, which natively store,
		// and every one after the quota threw QuotaExceededError. While any
		// operation is in flight every later one follows it, numbered, and the
		// worker applies them in that order; each request is sent at once,
		// since one waiting for the answer to the one before was lost when the
		// page unloaded first. Reads of such a key answer from here until the
		// write landed, which is what the page expects of its own writes;
		// other documents see the value once it is stored.
		const pending = new Map<string, Pending>();
		const pendingOf = (directory: string) => {
			let shadow = pending.get(directory);
			if (!shadow) {
				shadow = {
					values: new Map(),
					cleared: null,
					seq: 0,
					inflight: new Set(),
				};
				pending.set(directory, shadow);
			}
			return shadow;
		};
		const busy = (directory: string) => !!pending.get(directory)?.inflight.size;
		const post = (directory: string, name: string, args: unknown[]) =>
			fetch(new URL(`${directory}${name}`, this.client.global.location.href), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(args),
			}).then((response) => {
				if (!response.ok)
					throw new Error(`${name}: ${response.status} ${response.statusText}`);
			});
		const later = (
			directory: string,
			name: 'setItem' | 'removeItem' | 'clear',
			args: unknown[],
			key: string | null,
			value: string | null,
		) => {
			const shadow = pendingOf(directory);
			const seq = shadow.seq++;
			shadow.inflight.add(seq);
			// every operation before the oldest in flight has landed, so a
			// worker that started since waits for none of those
			let base = seq;
			for (const other of shadow.inflight) base = Math.min(base, other);
			if (key === null) {
				shadow.cleared = seq;
				for (const entry of shadow.values.values()) {
					entry.value = null;
					entry.seq = seq;
				}
			} else shadow.values.set(key, { value, seq });
			// landed (or lost): from now on every document reads the worker's
			const settle = () => {
				shadow.inflight.delete(seq);
				if (shadow.cleared === seq) shadow.cleared = null;
				for (const [item, entry] of shadow.values)
					if (entry.seq === seq) shadow.values.delete(item);
				changed(directory, true);
			};
			post(directory, 'ordered', [sender, seq, base, name, args]).then(
				settle,
				(error) => {
					console.error(`Stomp: a storage write could not be stored: ${error}`);
					settle();
				},
			);
		};

		/** `value` of `key` as this document sees it; undefined: ask the worker */
		const shadowed = (directory: string, key: string) => {
			const shadow = pending.get(directory);
			const entry = shadow?.values.get(key);
			if (entry) return entry.value;
			if (shadow && shadow.cleared !== null) return null;
			return undefined;
		};

		// One answer of the bridge rides in cookies, of which Chrome keeps
		// about 180 per host: a value of about 700 KiB or more never arrived
		// whole and the read spun to its limit. The worker answers a part at a
		// time, each with the value's tag, so the parts are of one value.
		const readItem = (directory: string, key: string): string | null => {
			for (let attempt = 0; ; attempt++) {
				const parts: string[] = [];
				let tag: string | undefined;
				let length = 0;
				let have = 0;
				let torn = false;
				do {
					const part: {
						part: string;
						length: number;
						tag: string;
					} | null = syncModule.jsonAPI(
						`${directory}getItemPart`,
						getOrigin(),
						key,
						have,
					);
					if (part === null && tag === undefined) return null;
					if (
						part === null ||
						(tag !== undefined && (part.tag !== tag || part.length !== length))
					) {
						torn = true;
						break;
					}
					tag = part.tag;
					length = part.length;
					parts.push(part.part);
					have += part.part.length;
					if (!part.part.length && have < length) {
						torn = true;
						break;
					}
				} while (have < length);
				if (!torn) return parts.join('');
				// another document wrote between two parts: read it again, and
				// after a few tries in one answer, which a value that fits takes
				if (attempt >= 4)
					return syncModule.jsonAPI(`${directory}getItem`, getOrigin(), key);
			}
		};

		/**
		 * What the store would come to with `key` set to `value` (null: not
		 * known), or null when that is over the quota
		 */
		const sizeAfter = (
			directory: string,
			key: string,
			value: string,
		): { usage: number | null } | null => {
			const size = sizeOf(key, value);
			if (size > QUOTA) return null;
			const cache = current(directory);
			if (cache && cache.usage !== null && cache.usage + size <= QUOTA)
				return { usage: cache.usage + size };
			// near the quota (or not known yet): exactly, from the worker's sizes
			// and the operations it may not have yet
			const shadow = pending.get(directory);
			const others = [...(shadow?.values ?? [])].filter(
				([item]) => item !== key,
			);
			let usage: [total: number, sizes: number[]];
			try {
				usage = syncModule.jsonAPI(`${directory}getUsage`, getOrigin(), [
					key,
					...others.map(([item]) => item),
				]);
			} catch (error) {
				// the bridge cannot ask now; a write the page made natively
				// would not fail for that
				return { usage: null };
			}
			const [total, sizes] = usage;
			let after =
				shadow && shadow.cleared !== null
					? 0
					: total - sizes.reduce((sum, item) => sum + item, 0);
			for (const [item, entry] of others)
				if (entry.value !== null) after += sizeOf(item, entry.value);
			after += size;
			return after > QUOTA ? null : { usage: after };
		};
		const counted = (directory: string, usage: number | null) => {
			const cache = current(directory);
			if (cache) cache.usage = usage;
		};
		/** the size `key` takes now, as far as this document knows */
		const knownSize = (directory: string, key: string) => {
			const value =
				shadowed(directory, key) ?? caches.get(directory)?.values.get(key);
			return value === undefined
				? undefined
				: value === null
					? 0
					: sizeOf(key, value);
		};

		const storageKeys = (directory: string): string[] => {
			const shadow = pending.get(directory);
			if (shadow && shadow.cleared !== null)
				return [...shadow.values]
					.filter(([, entry]) => entry.value !== null)
					.map(([key]) => key);
			const cache = current(directory);
			const keys: string[] =
				cache?.keys?.slice() ??
				syncModule.jsonAPI(`${directory}getKeys`, this.client.url.url.origin);
			if (cache && !cache.keys) cache.keys = keys.slice();
			if (!shadow?.values.size) return keys;
			const merged = keys.filter(
				(key) => shadow.values.get(key)?.value !== null,
			);
			for (const [key, entry] of shadow.values)
				if (entry.value !== null && !merged.includes(key)) merged.push(key);
			return merged;
		};

		const realm = this.client.global;
		class StorageProxy {
			#directory: string;
			constructor(directory: string) {
				if (!building) {
					throw new TypeError(`Illegal constructor`);
				}

				this.#directory = directory;
			}
			clear(): void {
				const directory = this.#directory;
				const args = [getOrigin(), sender, here()];
				if (
					busy(directory) ||
					!syncModule.tryJsonAPI(WRITE_BUDGET, `${directory}clear`, ...args)
				)
					later(directory, 'clear', args, null, null);
				else wrote(directory, null, null);
				counted(directory, 0);
			}
			getItem(...args: [unknown]): string | null {
				catchRequiredArguments(args.length, 1, 'Storage', 'getItem');

				const key = String(args[0]);

				const shadow = shadowed(this.#directory, key);
				if (shadow !== undefined) return shadow;

				const cache = current(this.#directory);
				if (cache?.values.has(key)) return cache.values.get(key)!;

				const result = readItem(this.#directory, key);
				cache?.values.set(key, result);

				return result;
			}
			key(...args: [unknown]): string | null {
				catchRequiredArguments(args.length, 1, 'Storage', 'key');

				const index = Number(args[0]);

				const result = storageKeys(this.#directory);

				return index >= result.length ? null : result[index];
			}
			get length(): number {
				return storageKeys(this.#directory).length;
			}
			removeItem(...args: [unknown]): void {
				catchRequiredArguments(args.length, 1, 'Storage', 'removeItem');

				const directory = this.#directory;
				const item = String(args[0]);
				const before = current(directory)?.usage ?? null;
				const old = knownSize(directory, item);
				const call = [getOrigin(), item, sender, here()];

				if (
					busy(directory) ||
					!syncModule.tryJsonAPI(
						WRITE_BUDGET,
						`${directory}removeItem`,
						...call,
					)
				)
					later(directory, 'removeItem', call, item, null);
				else wrote(directory, item, null);
				if (before !== null && old !== undefined)
					counted(directory, before - old);
			}
			setItem(...args: [unknown, unknown]): void {
				catchRequiredArguments(args.length, 2, 'Storage', 'setItem');

				const directory = this.#directory;
				const item = String(args[0]);
				const value = String(args[1]);

				const after = sizeAfter(directory, item, value);
				if (after === null)
					throw new realm.DOMException(
						`Failed to execute 'setItem' on 'Storage': Setting the value of '${item}' exceeded the quota.`,
						'QuotaExceededError',
					);

				const call = [getOrigin(), item, value, sender, here()];
				if (
					busy(directory) ||
					// far over what the budget lets through, so not even encoded
					value.length > WRITE_BUDGET ||
					!syncModule.tryJsonAPI(WRITE_BUDGET, `${directory}setItem`, ...call)
				)
					later(directory, 'setItem', call, item, value);
				else wrote(directory, item, value);
				counted(directory, after.usage);
			}
		}

		const globalStorageProxy = newConstructor(StorageProxy);

		const natives = new WeakMap<object, StorageProxy>();

		proxyModule.bindNatives(globalStorageProxy.prototype, natives);
		proxyModule.mirrorClass(
			this.client.global.Storage,
			globalStorageProxy,
			instances,
		);

		function isStorageKey(
			target: StorageProxy,
			prop: string | symbol,
		): prop is string {
			if (typeof prop === 'symbol') {
				return false;
			}

			const stack: object[] = [target];

			while (true) {
				const object = stack.pop();

				if (!object) {
					return true;
				}

				if (Reflect.getOwnPropertyDescriptor(object, prop)) {
					return false;
				}

				const prototype = Reflect.getPrototypeOf(object);

				if (prototype) {
					stack.push(prototype);
				}
			}
		}

		const storageFactory = (directory: string, store: string) => {
			caches.set(directory, {
				store,
				version: '',
				values: new Map(),
				keys: null,
				usage: null,
			});
			const storage = new StorageProxy(directory);
			const proxy = new Proxy(storage, {
				get: (target, prop, receiver) => {
					if (!isStorageKey(target, prop)) {
						return Reflect.get(target, prop, receiver);
					}

					return usePrototype(storage, StorageProxy.prototype, (storage) => {
						const item = storage.getItem(prop);

						return item === null ? undefined : item;
					});
				},
				set: (target, prop, value) => {
					if (!isStorageKey(target, prop)) {
						return Reflect.set(target, prop, value);
					}

					return usePrototype(storage, StorageProxy.prototype, (storage) => {
						storage.setItem(prop, value);
						return true;
					});
				},
				getOwnPropertyDescriptor: (target, prop) => {
					if (!isStorageKey(target, prop)) {
						return Reflect.getOwnPropertyDescriptor(target, prop);
					}

					return usePrototype(storage, StorageProxy.prototype, (storage) => {
						const value = storage.getItem(prop);

						if (value === null) return undefined;

						return {
							value,
							writable: true,
							enumerable: true,
							configurable: true,
						};
					});
				},
				deleteProperty: (target, prop) => {
					if (!isStorageKey(target, prop)) {
						return Reflect.deleteProperty(target, prop);
					}

					return usePrototype(storage, StorageProxy.prototype, (storage) => {
						storage.removeItem(prop);

						return true;
					});
				},
				has: (target, prop) => {
					if (!isStorageKey(target, prop)) {
						return Reflect.has(target, prop);
					}

					return storageKeys(directory).includes(prop);
				},
				ownKeys: (target) => {
					const ownKeys = Reflect.ownKeys(target);

					// almost EXACTLY how ownKeys works on Storage instances
					return [...ownKeys, ...storageKeys(directory)];
				},
			});

			instances.add(storage);
			instances.add(proxy);
			natives.set(proxy, storage);

			return proxy;
		};

		const localStorage = storageFactory(
			`${this.client.directory}localStorage/`,
			'localStorage',
		);
		const sessionStorage = storageFactory(
			`${this.client.directory}sessionStorage/`,
			'sessionStorage',
		);

		building = false;

		// A storage event the browser fires is about the proxy origin's own
		// storage (the read stamps above, the Cookies module's, a same-origin
		// host's), never the page's, whose events are the ones dispatched
		// below: those are dropped before any page listener. document.open()
		// drops every listener on the window, so it is registered again after
		// each open.
		const global = this.client.global;
		const addListener = global.addEventListener;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		const dropBrowserEvents = () =>
			Reflect.apply(addListener, global, [
				'storage',
				(event: Event) => {
					if (event.isTrusted) Reflect.apply(stopImmediate, event, []);
				},
				true,
			]);
		dropBrowserEvents();
		addDocumentOpenListener(global, dropBrowserEvents);

		// changes made by the other documents of this origin arrive from the
		// service worker; the area must be our own object, which the event's
		// dictionary would reject, so it is set on the event afterwards
		this.client.onServiceWorkerMessage((data) => {
			const change = (data as Record<string, StorageChange> | null)?.[
				STORAGE_EVENT
			];
			if (!change || change.sender === sender || change.origin !== getOrigin())
				return;
			// the writer changed the stamp already; this is for a writer whose
			// stamp this document could not see
			changed(`${this.client.directory}${change.store}/`, false);
			if (change.store !== 'localStorage') return;
			const event = new this.client.global.StorageEvent('storage', {
				key: change.key,
				oldValue: change.oldValue,
				newValue: change.newValue,
				url: change.url ?? here(),
			});
			Reflect.defineProperty(event, 'storageArea', {
				value: localStorage,
				configurable: true,
			});
			this.client.global.dispatchEvent(event);
		});

		// constructor becomes equivalent to constructor() when building = false
		this.client.global.Storage = <{ new (): StorageProxy }>globalStorageProxy;

		Reflect.defineProperty(this.client.global, 'localStorage', {
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(this.client.global, 'sessionStorage')!
					.get!,
				(target, that) => {
					if (contextThis(that, this.client.global) !== this.client.global) {
						throw new TypeError('Illegal invocation');
					}

					return localStorage;
				},
			),
			enumerable: true,
			configurable: true,
		});

		Reflect.defineProperty(this.client.global, 'sessionStorage', {
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(this.client.global, 'sessionStorage')!
					.get!,
				(target, that) => {
					if (contextThis(that, this.client.global) !== this.client.global) {
						throw new TypeError('Illegal invocation');
					}

					return sessionStorage;
				},
			),
			enumerable: true,
			configurable: true,
		});
	}
}
