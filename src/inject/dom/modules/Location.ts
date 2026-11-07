import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { setGlobalProxy } from '../../modules/Access';
import ProxyModule, { invokeGlobal } from '../../modules/Proxy';
import DocumentClient from '../Client';

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
									return Reflect.apply(target, location, args);

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
									return Reflect.apply(target, location, args);

								const temp = new URL(this.client.location.toString());

								if (common === 'href') {
									args[0] = new URL(args[0], this.client.url.toString());
								}

								Reflect.apply(urlDescriptor.set!, temp, args);

								location.href = routeHTML(
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

		// a top-level document has no ancestors; never reveal the host origin.
		// DOMStringList.prototype.length is a getter, so define own properties
		// rather than assigning.
		const emptyAncestors = Object.freeze(
			Object.create(this.client.global.DOMStringList.prototype, {
				length: { value: 0, enumerable: true },
				item: { value: () => null },
				contains: { value: () => false },
				[Symbol.iterator]: {
					value: function* () {},
				},
			}),
		);
		Reflect.defineProperty(proxy, 'ancestorOrigins', {
			configurable: true,
			enumerable: true,
			get: () => emptyAncestors,
		});

		Reflect.defineProperty(proxy, 'assign', {
			value: proxyModule.wrapFunction(
				location.assign,
				(target, that, [url]) => {
					return Reflect.apply(target, location, [
						routeHTML(
							new StompURL(
								new URL(url, this.client.url.toString()),
								this.client.url,
							),
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
				location.replace,
				(target, that, [url]) => {
					return Reflect.apply(target, location, [
						routeHTML(
							new StompURL(
								new URL(url, this.client.url.toString()),
								this.client.url,
							),
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
		// the proxy needs its own copy or `location.reload()` is undefined
		Reflect.defineProperty(proxy, 'reload', {
			value: proxyModule.wrapFunction(location.reload, (target) =>
				Reflect.apply(target, location, []),
			),
			writable: false,
			enumerable: true,
			configurable: false,
		});

		Reflect.defineProperty(proxy, 'toString', {
			value: proxyModule.wrapFunction(location.assign, (target, that) => {
				invokeGlobal(that, proxy);
				return this.client.url.toString();
			}),
			writable: false,
			enumerable: true,
			configurable: false,
		});

		Reflect.defineProperty(proxy, 'valueOf', {
			value: proxyModule.wrapFunction(location.assign, (target, that) => {
				invokeGlobal(that, proxy);
				return proxy;
			}),
			writable: false,
			enumerable: false,
			configurable: false,
		});

		Reflect.setPrototypeOf(proxy, Location.prototype);

		setGlobalProxy(location, 'location', proxy);
	}
}
