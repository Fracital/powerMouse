import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

/**
 * Every proxied origin shares the proxy's real origin, so what the browser
 * keys by origin must be keyed by the proxied origin here: BroadcastChannel
 * names, Cache API cache names and the origin private file system's root.
 * The page reads its own names back.
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
