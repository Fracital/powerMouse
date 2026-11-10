import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

/**
 * Every proxied origin shares the proxy's real origin, so what the browser
 * keys by origin must be keyed by the proxied origin here: BroadcastChannel
 * names, Cache API cache names, Web Locks and the origin private file
 * system's root. The page reads its own names back.
 */
export default class PartitionModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		const suffix = () => `@${this.client.url.url.origin}`;
		const scoped = (name: unknown) => `${String(name)}${suffix()}`;
		const unscoped = (name: string) =>
			name.endsWith(suffix()) ? name.slice(0, -suffix().length) : name;

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
					if (args.length) args[0] = scoped(args[0]);
					return Reflect.apply(target, that, args);
				},
			) as LockManager['request'];
			type Info = { name?: string };
			const own = (list: Info[] | undefined) =>
				(list ?? [])
					.filter((lock) => lock.name?.endsWith(suffix()))
					.map((lock) => ({ ...lock, name: unscoped(lock.name!) }));
			manager.query = proxyModule.wrapFunction(
				manager.query,
				async (target, that, args) => {
					const snapshot = (await Reflect.apply(target, that, args)) as {
						held?: Info[];
						pending?: Info[];
					};
					return { held: own(snapshot.held), pending: own(snapshot.pending) };
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
						if (args.length) args[0] = scoped(args[0]);
						return Reflect.apply(target, that, args);
					},
				) as any;
			storage.keys = proxyModule.wrapFunction(
				storage.keys,
				async (target, that, args) =>
					((await Reflect.apply(target, that, args)) as string[])
						.filter((name) => name.endsWith(suffix()))
						.map(unscoped),
			) as any;
		}

		// a cache entry is keyed by the page's URL: a string resolves against
		// the page (the hooked Request constructor), so `keys()` and matches
		// come back as the page's; add() and addAll() fetch through the proxy
		if (typeof global.Cache === 'function') {
			const cache = global.Cache.prototype;
			const asRequest = (input: unknown): Request =>
				input instanceof global.Request
					? input
					: new global.Request(input as RequestInfo);
			for (const method of ['match', 'matchAll', 'delete', 'keys'] as const)
				cache[method] = proxyModule.wrapFunction(
					cache[method] as Function,
					(target, that, args) => {
						if (args.length && args[0] !== undefined)
							args[0] = asRequest(args[0]);
						return Reflect.apply(target, that, args);
					},
				) as any;
			const put = cache.put;
			cache.put = proxyModule.wrapFunction(put, (target, that, args) => {
				if (args.length) args[0] = asRequest(args[0]);
				return Reflect.apply(target, that, args);
			});
			cache.addAll = proxyModule.wrapFunction(
				cache.addAll,
				async (target, that, args) => {
					const requests = [...(args[0] as Iterable<unknown>)].map(asRequest);
					const responses = await Promise.all(
						requests.map((request) => global.fetch(request)),
					);
					for (const [index, response] of responses.entries()) {
						if (!response.ok)
							throw new TypeError(
								`Failed to execute 'addAll' on 'Cache': Request failed`,
							);
						await Reflect.apply(put, that, [requests[index], response]);
					}
				},
			);
			cache.add = proxyModule.wrapFunction(cache.add, (target, that, args) =>
				(that as Cache).addAll([args[0] as RequestInfo]),
			);
		}
		// caches.match() looks in this origin's caches only, in the order they
		// were made, as the browser looks in the origin's: natively it would
		// search every proxied site's caches and Stomp's own HTTP cache, whose
		// entries are keyed by the real URLs and hold the origin's raw bodies
		if (typeof global.CacheStorage === 'function') {
			const storage = global.CacheStorage.prototype;
			const nativeKeys = keysOf;
			const nativeOpen = openOf;
			const nativeHas = hasOf;
			storage.match = proxyModule.wrapFunction(
				storage.match,
				async (target, that, args) => {
					if (args.length && args[0] !== undefined)
						args[0] =
							args[0] instanceof global.Request
								? args[0]
								: new global.Request(args[0] as RequestInfo);
					const options = args[1] as MultiCacheQueryOptions | undefined;
					const names =
						options?.cacheName !== undefined
							? (await Reflect.apply(nativeHas, that, [
									scoped(options.cacheName),
								]))
								? [scoped(options.cacheName)]
								: []
							: (
									(await Reflect.apply(nativeKeys, that, [])) as string[]
								).filter((name) => name.endsWith(suffix()));
					for (const name of names) {
						const cache = (await Reflect.apply(nativeOpen, that, [
							name,
						])) as Cache;
						const hit = await cache.match(args[0] as RequestInfo, options);
						if (hit) return hit;
					}
					return undefined;
				},
			);
		}

		if (typeof global.StorageManager === 'function') {
			const manager = global.StorageManager.prototype;
			if (typeof manager.getDirectory === 'function')
				manager.getDirectory = proxyModule.wrapFunction(
					manager.getDirectory,
					async (target, that, args) => {
						const root: FileSystemDirectoryHandle = await Reflect.apply(
							target,
							that,
							args,
						);
						// a directory per proxied origin, under the real root
						return root.getDirectoryHandle(
							encodeURIComponent(this.client.url.url.origin),
							{ create: true },
						);
					},
				) as any;
		}
	}
}
