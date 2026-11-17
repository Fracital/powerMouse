import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { setGlobalProxy } from '../../modules/Access';
import ProxyModule from '../../modules/Proxy';
import { failsToParse, withStack } from '../../nativeErrors';
import DocumentClient from '../Client';
import FragmentModule from './Fragment';
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

		// the realm's own, kept: a window that lost its browsing context (a
		// removed frame's) has none of its interfaces any more
		const PageDOMException = this.client.global.DOMException;

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
		/** a javascript: URL's code, as the browser hands it a default policy */
		const decoded = (url: string) => {
			// (a URL keeps no tab or line break)
			const code = url.slice('javascript:'.length).replace(/[\t\n\r]/g, '');
			try {
				return decodeURIComponent(code);
			} catch (error) {
				return code;
			}
		};
		// a fragment's navigation goes to it as written (the Fragment module)
		const fragments = this.client.getModule(FragmentModule);
		const navigateTo = (destination: URL) => {
			const routed = routeHTML(
				new StompURL(destination, this.client.url),
				this.client.url,
				this.client.config,
				false,
				this.client.nestedRoute,
			);
			return fragments ? fragments.live(routed) : routed;
		};

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
			// a frame still on its initial about:blank fires no navigate event:
			// one sent to another origin gets a fresh context first (IFrame)
			if (this.client.freshTo?.(destination)) return;
			const loading = this.client.global.document.readyState !== 'complete';
			const how = loading ? 'replace' : method;
			// a javascript: URL's code is the page's Trusted Types' to judge
			// (as Chrome does: the default policy's sink `Location href`, the
			// code decoded); refused, the browser is handed the page's URL,
			// which it refuses and reports itself
			const route =
				how === 'assign'
					? (fragments?.live(this.client.navigationRoute(destination)) ??
						this.client.navigationRoute(destination))
					: navigateTo(destination);
			if (
				destination.protocol === 'javascript:' &&
				this.client.trustedJavascript?.(
					decoded(destination.href),
					decoded(route),
					// navigate to the rewrite (the inject's, which no Trusted Types
					// judge); the page's Trusted Types judge its code (trustedJavascript)
					() => Reflect.apply(real[how], real, [route]),
				) === false
			)
				// refused, or deferred to the page's default policy (async, as the
				// navigation is): the inject navigates itself where it may
				return;
			return Reflect.apply(real[how], real, [route]);
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
							const temp = new URL(this.client.location.toString());

							return Reflect.apply(urlDescriptor.get!, temp, args);
						})
					: undefined,
				set: locationDescriptor.set
					? member(locationDescriptor.set, (args) => {
							const temp = new URL(this.client.location.toString());

							if (common === 'href') {
								// one that does not parse: the browser's own SyntaxError,
								// which names it as the page wrote it, and no navigation
								const url = String(args[0]);
								if (failsToParse(this.client, url))
									return Reflect.apply(locationDescriptor.set!, real, [url]);
								args[0] = new URL(url, this.client.baseURL.toString());
							}

							// Location's own: a value that is no scheme throws, where
							// URL's setter leaves the URL as it is (and the page then
							// navigated to its own address: a reload). Chrome takes
							// the value up to its first colon as written, a tab or a
							// line break in it too, and names it so in the message
							// (measured, 152)
							if (
								common === 'protocol' &&
								!/^[a-z][a-z\d+.-]*$/i.test(String(args[0]).split(':')[0])
							)
								throw withStack(
									new PageDOMException(
										`Failed to set the 'protocol' property on 'Location': '${String(args[0])}' is an invalid protocol.`,
										'SyntaxError',
									),
								);

							if (common === 'hash') {
								// Location's own: '' is an empty fragment (`page#`), and
								// the fragment the document is at already is no navigation
								// (nor is '' where it has none: measured, url-shapes).
								// The document's own address: an about:srcdoc document's
								// `url` is its parent's
								const input = String(args[0]).replace(/^#/, '');
								const at = temp.href;
								if (!input && !at.includes('#')) return;
								if (input) Reflect.apply(urlDescriptor.set!, temp, [input]);
								else temp.href = `${temp.href.split('#')[0]}#`;
								if (temp.href === at) return;
							} else Reflect.apply(urlDescriptor.set!, temp, args);

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
					// its origin as a page sees it: "null" for an opaque one (a
					// frame sandboxed without allow-same-origin, a data: document)
					origins.push(
						(parent as any)[this.client.names.client].origin as string,
					);
					context = parent;
				} catch (error) {
					// a cross-origin parent
					break;
				}
			}
			return origins;
		};
		// The list is an object of DOMStringList.prototype whose own
		// properties are the browser's (an index for each origin, as a legacy
		// platform object lists its items: not writable, enumerable,
		// configurable) and whose length, item and contains are the
		// prototype's, hooked the first time a list is made to answer for it
		// (most documents never read one). It was an object with `length`,
		// `item`, `contains` and an iterator of its own, frozen: four keys and
		// three function sources the browser's list does not have.
		const lists = new WeakMap<object, string[]>();
		// the same list every time, as natively, until the ancestors change
		// (a removed frame's location has none, and a new list)
		let kept: { origins: string; list: object } | null = null;
		const hooked = new WeakSet<object>();
		// (the prototype of the browser's own list: a removed frame's window
		// has no DOMStringList of its own any more, and still lists)
		const listPrototype = () =>
			Reflect.getPrototypeOf(
				Reflect.apply(ancestorDescriptor!.get!, real, []) as object,
			) as object;
		const hookListPrototype = (prototype: object) => {
			if (hooked.has(prototype)) return;
			hooked.add(prototype);
			const proxyModule = this.client.getModule(ProxyModule)!;
			const answers: Record<
				string,
				(origins: string[], args: any[]) => unknown
			> = {
				length: (origins) => origins.length,
				// (an index as the browser reads one: an unsigned long)
				item: (origins, args) => origins[Number(args[0]) >>> 0] ?? null,
				contains: (origins, args) => origins.includes(String(args[0])),
			};
			for (const key of Object.keys(answers)) {
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
				const part = descriptor?.get ? 'get' : 'value';
				const native = descriptor?.[part] as Function | undefined;
				if (!descriptor || typeof native !== 'function') continue;
				Reflect.defineProperty(prototype, key, {
					...descriptor,
					[part]: proxyModule.wrapFunction(native, (target, that, args) => {
						const origins = lists.get(that);
						// (the browser's own answer for its own lists, and its
						// errors: a receiver that is no list, a call with no
						// argument)
						if (!origins || args.length < target.length)
							return Reflect.apply(
								target,
								origins ? this.client.global.location.ancestorOrigins : that,
								args,
							);
						return answers[key](origins, args);
					}),
				});
			}
		};
		const ancestorList = () => {
			const origins = ancestorOrigins();
			const key = origins.join(' ');
			if (kept && kept.origins === key) return kept.list;
			const prototype = listPrototype();
			hookListPrototype(prototype);
			const descriptors: PropertyDescriptorMap = {};
			origins.forEach((origin, index) => {
				descriptors[index] = {
					value: origin,
					enumerable: true,
					configurable: true,
				};
			});
			const list = Object.create(prototype, descriptors) as object;
			lists.set(list, origins);
			kept = { origins: key, list };
			return list;
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

		const navigation = (method: 'assign' | 'replace') => (args: any[]) => {
			// no URL, or one that does not parse: the browser's own error
			// for the call (a TypeError for the count, a SyntaxError that
			// names the URL as the page wrote it), and no navigation
			const url = args.length ? String(args[0]) : '';
			if (!args.length || failsToParse(this.client, url))
				return Reflect.apply(real[method], real, args.length ? [url] : []);
			const destination = new URL(url, this.client.baseURL.toString());
			this.client.getModule(NavigationHintModule)?.hint(destination.href);
			return go(destination, method);
		};
		const methods: Record<string, (args: any[]) => unknown> = {
			assign: navigation('assign'),
			replace: navigation('replace'),
			reload: () => {
				// a document a javascript: URL made has the URL of the document
				// it replaced, and a reload loads that URL. Its own address is an
				// inline document's (src/server/inline.ts), which the worker
				// serves once: reloaded there, the frame showed an error page
				const named = this.client.namedBase;
				if (
					typeof named === 'string' &&
					/^https?:/i.test(named) &&
					real.pathname.startsWith(`${this.client.directory}inline:`)
				)
					return Reflect.apply(real.replace, real, [
						navigateTo(new URL(this.client.location.toString())),
					]);
				return Reflect.apply(real.reload, real, []);
			},
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
