import { STORAGE_EVENT, StorageChange } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule, {
	catchRequiredArguments,
	contextThis,
	newConstructor,
	usePrototype,
} from '../../modules/Proxy';
import DocumentClient from '../Client';
import SyncModule from './Sync';

/** a value this long (bytes) does not fit the synchronous bridge's beacon with the rest of the request */
const LARGE_WRITE_BYTES = 48 * 1024;

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

		// A write the synchronous bridge cannot carry (its beacon is refused
		// over 64 KiB, and the quota is per document while this thread spins,
		// so no number of beacons helps) is kept here as this document's view
		// of the key and sent to the worker asynchronously, in order; a later
		// operation on a key with a write in flight is queued behind it, so
		// the worker sees them in the page's order. Reads of such a key answer
		// from here until the write landed, which is what the page expects of
		// its own writes; other documents see the value once it is stored.
		const shadows = new Map<string, Map<string, string | null>>();
		const shadowOf = (directory: string) => {
			let shadow = shadows.get(directory);
			if (!shadow) {
				shadow = new Map();
				shadows.set(directory, shadow);
			}
			return shadow;
		};
		let queue: Promise<unknown> = Promise.resolve();
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
			name: string,
			args: unknown[],
			key: string,
			value: string | null,
		) => {
			const shadow = shadowOf(directory);
			shadow.set(key, value);
			queue = queue.then(
				() => post(directory, name, args),
				() => post(directory, name, args),
			);
			queue.then(
				() => {
					if (shadow.get(key) === value) shadow.delete(key);
				},
				(error) => {
					console.error(`Stomp: a storage write could not be stored: ${error}`);
					if (shadow.get(key) === value) shadow.delete(key);
				},
			);
		};
		const encoder = new TextEncoder();
		const tooLargeForSync = (value: string) =>
			value.length > LARGE_WRITE_BYTES ||
			(value.length * 3 > LARGE_WRITE_BYTES &&
				encoder.encode(value).length > LARGE_WRITE_BYTES);

		const storageKeys = (directory: string): string[] => {
			const keys: string[] = syncModule.jsonAPI(
				`${directory}getKeys`,
				this.client.url.url.origin,
			);
			const shadow = shadows.get(directory);
			if (!shadow?.size) return keys;
			const merged = keys.filter((key) => shadow.get(key) !== null);
			for (const [key, value] of shadow)
				if (value !== null && !merged.includes(key)) merged.push(key);
			return merged;
		};

		class StorageProxy {
			#directory: string;
			constructor(directory: string) {
				if (!building) {
					throw new TypeError(`Illegal constructor`);
				}

				this.#directory = directory;
			}
			clear(): void {
				const shadow = shadows.get(this.#directory);
				if (shadow?.size) {
					// behind the writes in flight, so none of them lands after it
					for (const key of shadow.keys()) shadow.set(key, null);
					queue = queue.then(
						() => post(this.#directory, 'clear', [getOrigin(), sender, here()]),
						() => post(this.#directory, 'clear', [getOrigin(), sender, here()]),
					);
					queue.then(
						() => {
							for (const [key, value] of shadow)
								if (value === null) shadow.delete(key);
						},
						() => {},
					);
					return;
				}
				syncModule.jsonAPI(
					`${this.#directory}clear`,
					getOrigin(),
					sender,
					here(),
				);
			}
			getItem(...args: [unknown]): string | null {
				catchRequiredArguments(args.length, 1, 'Storage', 'getItem');

				const key = String(args[0]);

				const shadow = shadows.get(this.#directory);
				if (shadow?.has(key)) return shadow.get(key)!;

				const result: null | string = syncModule.jsonAPI(
					`${this.#directory}getItem`,
					getOrigin(),
					String(key),
				);

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

				const item = String(args[0]);

				if (shadows.get(this.#directory)?.has(item)) {
					later(
						this.#directory,
						'removeItem',
						[getOrigin(), item, sender, here()],
						item,
						null,
					);
					return;
				}
				syncModule.jsonAPI(
					`${this.#directory}removeItem`,
					getOrigin(),
					item,
					sender,
					here(),
				);
			}
			setItem(...args: [unknown, unknown]): void {
				catchRequiredArguments(args.length, 2, 'Storage', 'setItem');

				const item = String(args[0]);
				const value = String(args[1]);

				if (tooLargeForSync(value) || shadows.get(this.#directory)?.has(item)) {
					later(
						this.#directory,
						'setItem',
						[getOrigin(), item, value, sender, here()],
						item,
						value,
					);
					return;
				}
				syncModule.jsonAPI(
					`${this.#directory}setItem`,
					getOrigin(),
					item,
					value,
					sender,
					here(),
				);
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

		const storageFactory = (directory: string) => {
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
		);
		const sessionStorage = storageFactory(
			`${this.client.directory}sessionStorage/`,
		);

		building = false;

		// changes made by the other documents of this origin arrive from the
		// service worker; the area must be our own object, which the event's
		// dictionary would reject, so it is set on the event afterwards
		this.client.onServiceWorkerMessage((data) => {
			const change = (data as Record<string, StorageChange> | null)?.[
				STORAGE_EVENT
			];
			if (
				!change ||
				change.sender === sender ||
				change.origin !== getOrigin() ||
				change.store !== 'localStorage'
			)
				return;
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
