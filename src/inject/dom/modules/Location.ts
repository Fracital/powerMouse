import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { setGlobalProxy } from '../../modules/Access';
import ProxyModule, { invokeGlobal } from '../../modules/Proxy';
import DocumentClient from '../Client';
import NavigationHintModule from './NavigationHint';

/**
{
	assign: {
		value: 'function assign() {\n    [native code]\n}',
		writable: false,
		enumerable: true,
		configurable: false,
	},	
	replace: {
		value: 'function replace() {\n    [native code]\n}',
		writable: false,
		enumerable: true,
		configurable: false,
	},
	reload: {
		value: 'function reload() {\n    [native code]\n}',
		writable: false,
		enumerable: true,
		configurable: false,
	},
	toString: {
		value: 'function toString() {\n    [native code]\n}',
		writable: false,
		enumerable: true,
		configurable: false,
	},
	valueOf: {
		value: 'function valueOf() {\n    [native code]\n}',
		writable: false,
		enumerable: false,
		configurable: false,
	},
}
 */

export default class LocationModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const proxy = {};

		// both URL.prototype and location share these descriptors
		for (const common of [
			'href',
			'origin',
			'protocol',
			'host',
			'hostname',
			'port',
			'pathname',
			'search',
			'hash',
		]) {
			const urlDescriptor = Reflect.getOwnPropertyDescriptor(
				this.client.global.URL.prototype,
				common,
			);

			const locationDescriptor = Reflect.getOwnPropertyDescriptor(
				this.client.global.location,
				common,
			);

			if (!urlDescriptor || !locationDescriptor) {
				console.error(
					`Common property ${common} was missing on URL.prototype/location`,
				);
				continue;
			}

			Reflect.defineProperty(proxy, common, {
				...locationDescriptor,
				get: locationDescriptor.get
					? proxyModule?.wrapFunction(
							locationDescriptor.get,
							(target, that, args) => {
								if (common === 'hash')
									return Reflect.apply(
										target,
										this.client.global.location,
										args,
									);

								const temp = new URL(this.client.location.toString());

								return Reflect.apply(urlDescriptor.get!, temp, args);
							},
						)
					: undefined,
				set: locationDescriptor.set
					? proxyModule?.wrapFunction(
							locationDescriptor.set,
							(target, that, args) => {
								if (common === 'hash')
									return Reflect.apply(
										target,
										this.client.global.location,
										args,
									);

								const temp = new URL(this.client.location.toString());

								if (common === 'href') {
									args[0] = new URL(args[0], this.client.url.toString());
								}

								Reflect.apply(urlDescriptor.set!, temp, args);

								this.client.getModule(NavigationHintModule)?.hint(temp.href);
								this.client.global.location.href = routeHTML(
									new StompURL(temp, this.client.url),
									this.client.url,
									this.client.config,
									false,
									this.client.nestedRoute,
								);
							},
						)
					: undefined,
			});
		}

		// The real origins of the proxied documents above this one, nearest
		// first like the browser's list; the host (not a Stomp context) ends
		// the walk and is never revealed. DOMStringList.prototype.length is a
		// getter, so define own properties rather than assigning.
		const ancestorOrigins = (): string[] => {
			const origins: string[] = [];
			let context: typeof globalThis = this.client.global;
			while (true) {
				try {
					const parent = (context as any)[this.client.names.client]
						.parent as typeof globalThis;
					if (parent === context || !(this.client.names.client in parent))
						break;
					origins.push(
						(parent as any)[this.client.names.client].url.url.origin as string,
					);
					context = parent;
				} catch (error) {
					// a cross-origin parent
					break;
				}
			}
			return origins;
		};
		const ancestorList = () => {
			const origins = ancestorOrigins();
			const descriptors: PropertyDescriptorMap = {
				length: { value: origins.length, enumerable: true },
				item: { value: (index: number) => origins[index] ?? null },
				contains: { value: (origin: string) => origins.includes(origin) },
				[Symbol.iterator]: {
					value: function* () {
						yield* origins;
					},
				},
			};
			origins.forEach((origin, index) => {
				descriptors[index] = { value: origin, enumerable: true };
			});
			return Object.freeze(
				Object.create(this.client.global.DOMStringList.prototype, descriptors),
			);
		};
		Reflect.defineProperty(proxy, 'ancestorOrigins', {
			configurable: true,
			enumerable: true,
			get: ancestorList,
		});

		Reflect.defineProperty(proxy, 'assign', {
			value: proxyModule.wrapFunction(
				this.client.global.location.assign,
				(target, that, [url]) => {
					const destination = new URL(url, this.client.url.toString());
					this.client.getModule(NavigationHintModule)?.hint(destination.href);
					return Reflect.apply(target, this.client.global.location, [
						routeHTML(
							new StompURL(destination, this.client.url),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					]);
				},
			),
			writable: false,
			enumerable: true,
			configurable: false,
		});

		Reflect.defineProperty(proxy, 'replace', {
			value: proxyModule.wrapFunction(
				this.client.global.location.replace,
				(target, that, [url]) => {
					const destination = new URL(url, this.client.url.toString());
					this.client.getModule(NavigationHintModule)?.hint(destination.href);
					return Reflect.apply(target, this.client.global.location, [
						routeHTML(
							new StompURL(destination, this.client.url),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					]);
				},
			),
			writable: false,
			enumerable: true,
			configurable: false,
		});

		// an own property of the real location, not of Location.prototype, so
		// the proxy needs its own copy or `this.client.global.location.reload()` is undefined
		Reflect.defineProperty(proxy, 'reload', {
			value: proxyModule.wrapFunction(
				this.client.global.location.reload,
				(target) => Reflect.apply(target, this.client.global.location, []),
			),
			writable: false,
			enumerable: true,
			configurable: false,
		});

		Reflect.defineProperty(proxy, 'toString', {
			value: proxyModule.wrapFunction(
				this.client.global.location.assign,
				(target, that) => {
					invokeGlobal(that, proxy);
					return this.client.url.toString();
				},
			),
			writable: false,
			enumerable: true,
			configurable: false,
		});

		Reflect.defineProperty(proxy, 'valueOf', {
			value: proxyModule.wrapFunction(
				this.client.global.location.assign,
				(target, that) => {
					invokeGlobal(that, proxy);
					return proxy;
				},
			),
			writable: false,
			enumerable: false,
			configurable: false,
		});

		Reflect.setPrototypeOf(proxy, this.client.global.Location.prototype);

		setGlobalProxy(
			this.client.global.location,
			'location',
			proxy,
			this.client.names,
		);
	}
}
