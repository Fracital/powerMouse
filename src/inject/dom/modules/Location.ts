import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import { setGlobalProxy } from '../../modules/Access';
import ProxyModule, { memberName } from '../../modules/Proxy';
import { failsToParse, withStack } from '../../nativeErrors';
import { LazyWeakMap } from '../../ownCollections';
import DocumentClient from '../Client';
import { deferred } from '../deferred';
import { siteWindows } from '../siteWindows';
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
		const moduleClient = this.client;
		const global = moduleClient.global;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const real = global.location;

		// the realm's own, kept: a window that lost its browsing context (a
		// removed frame's) has none of its interfaces any more
		const PageDOMException = global.DOMException;

		const proxy = {};
		// the page's location, or the real one it stands for
		const ours = (that: unknown) => that === proxy || that === real;
		// what each member's native does for the page's location, and the one
		// call every member's wrapper makes (a call of its own for each was a
		// closure and its scope in every frame)
		const owns = new LazyWeakMap<
			Function,
			(args: any[], target: Function) => unknown
		>();
		const call = (target: Function, that: unknown, args: any[]) =>
			ours(that)
				? owns.get(target)!(args, target)
				: Reflect.apply(target, that, args);
		/** `native` for the page: `own` when called on its location */
		const member = <T extends Function>(
			native: T,
			own: (args: any[], target: Function) => unknown,
		): T => {
			// (a native that is two members: each its own call)
			if (owns.has(native))
				return proxyModule.wrapFunction(native, (target, that, args) =>
					ours(that) ? own(args, target) : Reflect.apply(target, that, args),
				);
			owns.set(native, own);
			return proxyModule.wrapFunction(native, call);
		};
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
		const fragments = moduleClient.getModule(FragmentModule);
		const navigateTo = (destination: URL) => {
			const routed = routeHTML(
				new StompURL(destination, moduleClient.url),
				moduleClient.url,
				moduleClient.config,
				false,
				moduleClient.nestedRoute,
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
			if (moduleClient.freshTo?.(destination)) return;
			const loading = global.document.readyState !== 'complete';
			const how = loading ? 'replace' : method;
			// a javascript: URL's code is the page's Trusted Types' to judge
			// (as Chrome does: the default policy's sink `Location href`, the
			// code decoded); refused, the browser is handed the page's URL,
			// which it refuses and reports itself
			const route =
				how === 'assign'
					? (fragments?.live(moduleClient.navigationRoute(destination)) ??
						moduleClient.navigationRoute(destination))
					: navigateTo(destination);
			if (
				destination.protocol === 'javascript:' &&
				moduleClient.trustedJavascript?.(
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
		// each part's URL descriptor, and one getter and one setter call for
		// all of them, which read which part they are from the native they wrap
		const urlParts: Record<string, PropertyDescriptor> = Object.create(null);
		// the location's URL, parsed once per address: the part getters only
		// read it, and a parse on every `location.pathname` was a third of
		// its cost
		let parsed: URL | undefined;
		let parsedHref: string | undefined;
		const partGet = (args: any[], target: Function) => {
			const href = moduleClient.locationHref;
			if (parsed === undefined || parsedHref !== href) {
				parsed = new URL(href);
				parsedHref = href;
			}

			return Reflect.apply(urlParts[memberName(target)].get!, parsed, args);
		};
		const partSet = (args: any[], target: Function) => {
			const common = memberName(target);
			const urlDescriptor = urlParts[common];
			const temp = new URL(moduleClient.locationHref);

			if (common === 'href') {
				// one that does not parse: the browser's own SyntaxError,
				// which names it as the page wrote it, and no navigation
				const url = String(args[0]);
				if (failsToParse(moduleClient, url))
					return Reflect.apply(target, real, [url]);
				args[0] = moduleClient.encodingParse(url, moduleClient.baseHref);
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

			moduleClient.getModule(NavigationHintModule)?.hint(temp.href);
			go(temp, 'assign');
		};
		for (const common of URL_PARTS) {
			const urlDescriptor = Reflect.getOwnPropertyDescriptor(
				global.URL.prototype,
				common,
			);

			const locationDescriptor = Reflect.getOwnPropertyDescriptor(real, common);

			if (!urlDescriptor || !locationDescriptor) {
				console.error(
					`Common property ${common} was missing on URL.prototype/location`,
				);
				continue;
			}

			urlParts[common] = urlDescriptor;
			members.set(common, {
				...locationDescriptor,
				get: locationDescriptor.get
					? member(locationDescriptor.get, partGet)
					: undefined,
				set: locationDescriptor.set
					? member(locationDescriptor.set, partSet)
					: undefined,
			});
		}

		// The real origins of the proxied documents above this one, nearest
		// first like the browser's list; the host (not a STomp context) ends
		// the walk and is never revealed. DOMStringList.prototype.length is a
		// getter, so define own properties rather than assigning.
		const ancestorOrigins = (): string[] => {
			const origins: string[] = [];
			let context: typeof globalThis = global;
			let last: DocumentClient = moduleClient;
			while (true) {
				try {
					const parent = (context as any)[moduleClient.names.client]
						.parent as typeof globalThis;
					if (parent === context || !(moduleClient.names.client in parent))
						break;
					// its origin as a page sees it: "null" for an opaque one (a
					// frame sandboxed without allow-same-origin, a data: document)
					last = (parent as any)[moduleClient.names.client];
					origins.push(last.origin as string);
					context = parent;
				} catch (error) {
					// a cross-origin parent
					break;
				}
			}
			// (the site pool: the top of another slot, named by the route)
			const sites = this.client.sites;
			if (sites && last.nested)
				origins.push(
					...siteWindows().ancestorsPast(
						this.client,
						sites,
						last,
						origins.length,
					),
				);
			return origins;
		};
		// the list, made by a deferred part (../ancestorOriginsList.ts) the
		// first time the page reads it: most documents never do
		let ancestorList: (() => object) | null = null;
		const ancestorDescriptor = Reflect.getOwnPropertyDescriptor(
			real,
			'ancestorOrigins',
		);
		if (ancestorDescriptor?.get)
			members.set('ancestorOrigins', {
				...ancestorDescriptor,
				get: member(ancestorDescriptor.get, () =>
					(ancestorList ??= deferred('ancestorOriginsList')({
						origins: ancestorOrigins,
						// (the prototype of the browser's own list: a removed
						// frame's window has no DOMStringList of its own any
						// more, and still lists)
						listPrototype: () =>
							Reflect.getPrototypeOf(
								Reflect.apply(ancestorDescriptor.get!, real, []) as object,
							) as object,
						ownList: () => global.location.ancestorOrigins,
						wrapFunction: (native, hook) =>
							moduleClient.getModule(ProxyModule)!.wrapFunction(native, hook),
					}))(),
				),
			});

		const navigation = (method: 'assign' | 'replace') => (args: any[]) => {
			// no URL, or one that does not parse: the browser's own error
			// for the call (a TypeError for the count, a SyntaxError that
			// names the URL as the page wrote it), and no navigation
			const url = args.length ? String(args[0]) : '';
			if (!args.length || failsToParse(moduleClient, url))
				return Reflect.apply(real[method], real, args.length ? [url] : []);
			const destination = moduleClient.encodingParse(
				url,
				moduleClient.baseHref,
			);
			moduleClient.getModule(NavigationHintModule)?.hint(destination.href);
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
				const named = moduleClient.namedBase;
				if (
					typeof named === 'string' &&
					/^https?:/i.test(named) &&
					real.pathname.startsWith(`${moduleClient.directory}inline:`)
				)
					return Reflect.apply(real.replace, real, [
						navigateTo(new URL(moduleClient.location.toString())),
					]);
				return Reflect.apply(real.reload, real, []);
			},
			// the location's own URL: the client's url is the base URLs resolve
			// against, which a document's <base href> moves
			toString: () => moduleClient.locationHref,
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
				key !== moduleClient.names.globalProxy &&
				key !== moduleClient.names.globalName
			)
				Reflect.defineProperty(
					proxy,
					key,
					Reflect.getOwnPropertyDescriptor(real, key)!,
				);
		}

		Reflect.setPrototypeOf(proxy, global.Location.prototype);

		setGlobalProxy(real, 'location', proxy, moduleClient.names);
	}
}
