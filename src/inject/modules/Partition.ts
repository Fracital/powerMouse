import { cacheCallParts } from '../cacheCallParts';
import type { CacheCalls } from '../cacheCalls';
import Client from '../Client';
import Module from '../Module';
import { redirected, unsuffixed } from '../storageRedirect';
import { adoptTypeMark, cacheableResponse } from './Fetch';
import ProxyModule from './Proxy';

/**
 * Every proxied origin shares the proxy's real origin, so what the browser
 * keys by origin must be keyed by the proxied origin here: BroadcastChannel
 * names, Cache API cache names, Web Locks and the origin private file
 * system's root. The page reads its own names back.
 */
export default class PartitionModule extends Module<Client> {
	apply() {
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		const global = client.global;
		const scoped = (name: unknown, key = client.storageKey) =>
			`${String(name)}@${key}`;
		// a name made through a Storage Access handle has the first-party key
		const unscoped = (name: string) =>
			unsuffixed(name, client.storageKey, client.url.url.origin);

		if (typeof global.BroadcastChannel === 'function') {
			global.BroadcastChannel = proxyModule.wrapFunction(
				global.BroadcastChannel,
				(target, that, args, newTarget) => {
					if (!newTarget)
						throw new TypeError(
							"Failed to construct 'BroadcastChannel': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
						);
					args[0] = scoped(args[0]);
					return Reflect.construct(target, args, newTarget);
				},
				true,
			) as typeof BroadcastChannel;
			const nameDescriptor = Reflect.getOwnPropertyDescriptor(
				global.BroadcastChannel.prototype,
				'name',
			)!;
			Reflect.defineProperty(global.BroadcastChannel.prototype, 'name', {
				...nameDescriptor,
				get: proxyModule.wrapFunction(nameDescriptor.get!, (target, that) =>
					unscoped(String(Reflect.apply(target, that, []))),
				),
			});
		}

		// a lock of another site is not this one's to wait for, and its name
		// is not this one's to read
		if (typeof global.LockManager === 'function') {
			const manager = global.LockManager.prototype;
			manager.request = proxyModule.wrapFunction(
				manager.request,
				(target, that, args) => {
					const [locks, key] = redirected(that, client.storageKey);
					if (args.length) args[0] = scoped(args[0], key);
					return Reflect.apply(target, locks, args);
				},
			) as LockManager['request'];
			type Info = { name?: string };
			const own = (list: Info[] | undefined, key: string) =>
				(list ?? [])
					.filter((lock) => lock.name?.endsWith(`@${key}`))
					.map((lock) => ({
						...lock,
						name: lock.name!.slice(0, -key.length - 1),
					}));
			manager.query = proxyModule.wrapFunction(
				manager.query,
				async (target, that, args) => {
					const [locks, key] = redirected(that, client.storageKey);
					const snapshot = (await Reflect.apply(target, locks, args)) as {
						held?: Info[];
						pending?: Info[];
					};
					return {
						held: own(snapshot.held, key),
						pending: own(snapshot.pending, key),
					};
				},
			) as LockManager['query'];
			const lockName = Reflect.getOwnPropertyDescriptor(
				global.Lock.prototype,
				'name',
			);
			if (lockName?.get)
				Reflect.defineProperty(global.Lock.prototype, 'name', {
					...lockName,
					get: proxyModule.wrapFunction(lockName.get, (target, that) =>
						unscoped(String(Reflect.apply(target, that, []))),
					),
				});
		}

		// the native members, before the hooks below replace them
		const keysOf = global.CacheStorage?.prototype.keys;
		const openOf = global.CacheStorage?.prototype.open;
		const hasOf = global.CacheStorage?.prototype.has;
		if (typeof global.CacheStorage === 'function') {
			const storage = global.CacheStorage.prototype;
			for (const method of ['open', 'has', 'delete'] as const)
				storage[method] = proxyModule.wrapFunction(
					storage[method],
					(target, that, args) => {
						const [caches, key] = redirected(that, client.storageKey);
						if (args.length) args[0] = scoped(args[0], key);
						return Reflect.apply(target, caches, args);
					},
				) as any;
			storage.keys = proxyModule.wrapFunction(
				storage.keys,
				async (target, that, args) => {
					const [caches, key] = redirected(that, client.storageKey);
					return ((await Reflect.apply(target, caches, args)) as string[])
						.filter((name) => name.endsWith(`@${key}`))
						.map((name) => name.slice(0, -key.length - 1));
				},
			) as any;
		}

		// a cache entry is keyed by the page's URL: a string resolves against
		// the page (the hooked Request constructor), so `keys()` and matches
		// come back as the page's; add() and addAll() fetch through the proxy
		// A call the browser refuses before it does anything is the
		// browser's to answer, with its own rejection: one with no argument
		// where one is required, and one whose receiver is plainly none of
		// the interface (the prototype itself, as a script that tests for
		// hooks calls it)
		const isPrototypeOf = global.Object.prototype.isPrototypeOf;
		const refused = (
			that: unknown,
			C: { prototype: object },
			args: unknown[],
		) =>
			!args.length ||
			typeof that !== 'object' ||
			that === null ||
			!Reflect.apply(isPrototypeOf, C.prototype, [that]);
		const asRequest = (input: unknown): Request =>
			input instanceof global.Request
				? input
				: new global.Request(input as RequestInfo);
		// what add() and addAll() fetch and keep, and caches.match()'s walk
		// of this origin's caches (../cacheCalls.ts), made at a realm's first
		// such call, before the browser is asked anything
		const nativePut = global.Cache?.prototype.put;
		let calls: CacheCalls | undefined;
		const cacheCalls = () =>
			(calls ??= cacheCallParts.calls!()({
				global,
				asRequest,
				put: nativePut,
				keys: keysOf,
				open: openOf,
				has: hasOf,
				client,
				scoped,
			}));
		if (typeof global.Cache === 'function') {
			const cache = global.Cache.prototype;
			for (const method of ['delete', 'keys'] as const)
				cache[method] = proxyModule.wrapFunction(
					cache[method] as Function,
					(target, that, args) => {
						if (args.length && args[0] !== undefined)
							args[0] = asRequest(args[0]);
						return Reflect.apply(target, that, args);
					},
				) as any;
			// a kept cors or opaque response reads as one again (Fetch's
			// cacheableResponse marked it when it was put)
			cache.match = proxyModule.wrapFunction(
				cache.match,
				async (target, that, args) => {
					if (args.length && args[0] !== undefined)
						args[0] = asRequest(args[0]);
					const hit = (await Reflect.apply(target, that, args)) as
						Response | undefined;
					if (hit) adoptTypeMark(hit);
					return hit;
				},
			) as Cache['match'];
			cache.matchAll = proxyModule.wrapFunction(
				cache.matchAll,
				async (target, that, args) => {
					if (args.length && args[0] !== undefined)
						args[0] = asRequest(args[0]);
					const hits = (await Reflect.apply(
						target,
						that,
						args,
					)) as readonly Response[];
					for (const hit of hits) adoptTypeMark(hit);
					return hits;
				},
			) as Cache['matchAll'];
			const put = cache.put;
			cache.put = proxyModule.wrapFunction(put, (target, that, args) => {
				if (args.length) args[0] = asRequest(args[0]);
				if (args.length > 1) args[1] = cacheableResponse(args[1]);
				return Reflect.apply(target, that, args);
			});
			const addAll = (cache.addAll = proxyModule.wrapFunction(
				cache.addAll,
				async (target, that, args) =>
					refused(that, global.Cache, args)
						? await Reflect.apply(target, that, args)
						: await cacheCalls().addAll(that as Cache, args[0]),
			));
			cache.add = proxyModule.wrapFunction(cache.add, (target, that, args) =>
				refused(that, global.Cache, args)
					? Reflect.apply(target, that, args)
					: Reflect.apply(addAll, that, [[args[0] as RequestInfo]]),
			);
		}
		// caches.match() looks in this origin's caches only, in the order they
		// were made, as the browser looks in the origin's: natively it would
		// search every proxied site's caches and STomp's own HTTP cache, whose
		// entries are keyed by the real URLs and hold the origin's raw bodies
		if (typeof global.CacheStorage === 'function') {
			const storage = global.CacheStorage.prototype;
			storage.match = proxyModule.wrapFunction(
				storage.match,
				async (target, receiver, args) =>
					refused(receiver, global.CacheStorage, args)
						? await Reflect.apply(target, receiver, args)
						: await cacheCalls().match(receiver, args),
			);
		}

		if (typeof global.StorageManager === 'function') {
			const manager = global.StorageManager.prototype;
			if (typeof manager.getDirectory === 'function')
				manager.getDirectory = proxyModule.wrapFunction(
					manager.getDirectory,
					async (target, receiver, args) => {
						const [that, key] = redirected(receiver, client.storageKey);
						const root: FileSystemDirectoryHandle = await Reflect.apply(
							target,
							that,
							args,
						);
						// a directory per proxied origin (and partition), under the
						// real root
						return root.getDirectoryHandle(encodeURIComponent(key), {
							create: true,
						});
					},
				) as any;
		}
	}
}
