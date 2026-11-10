import Module from '../../Module';
import { setGlobalProxy } from '../../modules/Access';
import ProxyModule from '../../modules/Proxy';
import WorkerClient from '../Client';

const URL_PARTS = [
	'href',
	'origin',
	'protocol',
	'host',
	'hostname',
	'port',
	'pathname',
	'search',
	'hash',
] as const;

/**
 * A worker's location is the page's view of it: the real script URL for a
 * worker started from a routed one, and for a worker started from a blob: URL
 * the same blob under the page's origin (the page made it there). `self.origin`
 * agrees, and a shared worker reads its own name back without the origin the
 * page's constructor hook appended to keep proxied origins apart. Like the
 * document's Location module, the stand-in is what rewritten code gets from
 * the access API; WorkerLocation.prototype itself is left alone.
 */
export default class WorkerLocationModule extends Module<WorkerClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const nativeLocation = global.location;
		const nativeHref = Reflect.getOwnPropertyDescriptor(
			global.WorkerLocation.prototype,
			'href',
		)!.get!;

		// the URL the worker should believe it runs at
		const spoofed = (): URL => {
			const real = String(Reflect.apply(nativeHref, nativeLocation, []));
			const page = this.client.url.url;
			if (real.startsWith('blob:')) {
				const slash = real.lastIndexOf('/');
				return new URL(`blob:${page.origin}${real.slice(slash)}`);
			}
			return new URL(this.client.url.toString());
		};

		// rewritten code reads `location` through the access API, which hands
		// it this stand-in; the bundle's own reads of the real location (the
		// client's URL, the routed prefix) stay native, like a document's
		const proxy = Object.create(global.WorkerLocation.prototype) as object;
		for (const part of URL_PARTS) {
			const urlGetter = Reflect.getOwnPropertyDescriptor(
				global.URL.prototype,
				part,
			)?.get;
			if (!urlGetter) continue;
			Reflect.defineProperty(proxy, part, {
				enumerable: true,
				configurable: false,
				get: proxyModule.wrapFunction(
					Reflect.getOwnPropertyDescriptor(
						global.WorkerLocation.prototype,
						part,
					)!.get!,
					() => Reflect.apply(urlGetter, spoofed(), []),
				),
			});
		}
		Reflect.defineProperty(proxy, 'toString', {
			enumerable: true,
			configurable: false,
			writable: false,
			value: proxyModule.wrapFunction(
				global.WorkerLocation.prototype.toString,
				() => spoofed().href,
			),
		});
		setGlobalProxy(nativeLocation, 'location', proxy, this.client.names);

		// `origin` and `name` live on the global itself ([Global] interfaces
		// put their attributes there) or on a prototype of the scope
		const own = (key: string): object => {
			let owner: object | null = global;
			while (owner && !Reflect.getOwnPropertyDescriptor(owner, key))
				owner = Object.getPrototypeOf(owner);
			return owner ?? global;
		};
		const originOwner = own('origin');
		const origin = Reflect.getOwnPropertyDescriptor(originOwner, 'origin');
		if (origin?.get)
			Reflect.defineProperty(originOwner, 'origin', {
				...origin,
				get: proxyModule.wrapFunction(origin.get, (target, that, args) =>
					that === global
						? spoofed().origin
						: Reflect.apply(target, that, args),
				),
			});
		const nameOwner = own('name');
		const name = Reflect.getOwnPropertyDescriptor(nameOwner, 'name');
		if (name?.get)
			Reflect.defineProperty(nameOwner, 'name', {
				...name,
				get: proxyModule.wrapFunction(name.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					const suffix = `@${this.client.storageKey}`;
					return typeof value === 'string' && value.endsWith(suffix)
						? value.slice(0, -suffix.length)
						: value;
				}),
			});
	}
}
