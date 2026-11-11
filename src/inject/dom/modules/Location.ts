import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { setGlobalProxy } from '../../modules/Access';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';
import NavigationHintModule from './NavigationHint';

// the parts of the URL a Location shares with URL.prototype
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
];

/**
 * The page's `location` is a stand-in (rewritten code gets it from the access
 * API; the bundle's own reads stay native): the real location's members,
 * every one with the real one's descriptor, in its order, its functions with
 * their names, lengths and sources, answering for the page's URL. A Location
 * keeps all of them as own, unforgeable properties: `valueOf` is the realm's
 * Object.prototype.valueOf and `Symbol.toPrimitive` is undefined, as on the
 * real one. A member called on anything but a location is the native one, so
 * it throws the browser's "Illegal invocation".
 */
export default class LocationModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const real = this.client.global.location;

		const proxy = {};
		// the page's location, or the real one it stands for
		const ours = (that: unknown) => that === proxy || that === real;
		/** `native` for the page: `own` when called on its location */
		const member = <T extends Function>(
			native: T,
			own: (args: any[]) => unknown,
		): T =>
			proxyModule.wrapFunction(native, (target, that, args) =>
				ours(that) ? own(args) : Reflect.apply(target, that, args),
			);
		const navigateTo = (destination: URL) =>
			routeHTML(
				new StompURL(destination, this.client.url),
				this.client.url,
				this.client.config,
				false,
				this.client.nestedRoute,
			);

		// Chrome replaces the current entry when a page's script navigates it
		// before its load event (a redirect while loading, measured right
		// after the link click that brought the page too). A proxied document
		// is written in after its own response, and the browser took such a
		// navigation for a new entry about one time in three: Back then went
		// to the redirecting page, which redirected again. So it is replaced
		// here, as natively. An entry the navigation does make goes through the
		// link route (src/visited.ts), which the browser's history records; a
		// replacement makes none and goes to the document's address
		const go = (destination: URL, method: 'assign' | 'replace') => {
			const loading = this.client.global.document.readyState !== 'complete';
			const how = loading ? 'replace' : method;
			return Reflect.apply(real[how], real, [
				how === 'assign'
					? this.client.navigationRoute(destination)
					: navigateTo(destination),
			]);
		};

		const members = new Map<string | symbol, PropertyDescriptor>();

		// both URL.prototype and location share these descriptors
		for (const common of URL_PARTS) {
			const urlDescriptor = Reflect.getOwnPropertyDescriptor(
				this.client.global.URL.prototype,
				common,
			);

			const locationDescriptor = Reflect.getOwnPropertyDescriptor(real, common);

			if (!urlDescriptor || !locationDescriptor) {
				console.error(
					`Common property ${common} was missing on URL.prototype/location`,
				);
				continue;
			}

			members.set(common, {
				...locationDescriptor,
				get: locationDescriptor.get
					? member(locationDescriptor.get, (args) => {
							if (common === 'hash')
								return Reflect.apply(locationDescriptor.get!, real, args);

							const temp = new URL(this.client.location.toString());

							return Reflect.apply(urlDescriptor.get!, temp, args);
						})
					: undefined,
				set: locationDescriptor.set
					? member(locationDescriptor.set, (args) => {
							if (common === 'hash')
								return Reflect.apply(locationDescriptor.set!, real, args);

							const temp = new URL(this.client.location.toString());

							if (common === 'href') {
								args[0] = new URL(args[0], this.client.baseURL.toString());
							}

							Reflect.apply(urlDescriptor.set!, temp, args);

							this.client.getModule(NavigationHintModule)?.hint(temp.href);
							go(temp, 'assign');
						})
					: undefined,
			});
		}

		// The real origins of the proxied documents above this one, nearest
		// first like the browser's list; the host (not a STomp context) ends
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
		const ancestorDescriptor = Reflect.getOwnPropertyDescriptor(
			real,
			'ancestorOrigins',
		);
		if (ancestorDescriptor?.get)
			members.set('ancestorOrigins', {
				...ancestorDescriptor,
				get: member(ancestorDescriptor.get, ancestorList),
			});

		const navigation =
			(method: 'assign' | 'replace') =>
			([url]: any[]) => {
				const destination = new URL(url, this.client.baseURL.toString());
				this.client.getModule(NavigationHintModule)?.hint(destination.href);
				return go(destination, method);
			};
		const methods: Record<string, (args: any[]) => unknown> = {
			assign: navigation('assign'),
			replace: navigation('replace'),
			reload: () => Reflect.apply(real.reload, real, []),
			// the location's own URL: the client's url is the base URLs resolve
			// against, which a document's <base href> moves
			toString: () => this.client.location.toString(),
		};
		for (const [name, own] of Object.entries(methods)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(real, name);
			if (typeof descriptor?.value === 'function')
				members.set(name, {
					...descriptor,
					value: member(descriptor.value, own),
				});
		}

		// every other member (valueOf, Symbol.toPrimitive) is the real one's,
		// which answers for whatever it is called on
		for (const key of Reflect.ownKeys(real)) {
			const descriptor = members.get(key);
			if (descriptor) Reflect.defineProperty(proxy, key, descriptor);
			else if (
				key !== this.client.names.globalProxy &&
				key !== this.client.names.globalName
			)
				Reflect.defineProperty(
					proxy,
					key,
					Reflect.getOwnPropertyDescriptor(real, key)!,
				);
		}

		Reflect.setPrototypeOf(proxy, this.client.global.Location.prototype);

		setGlobalProxy(real, 'location', proxy, this.client.names);
	}
}
