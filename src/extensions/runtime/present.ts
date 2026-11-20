// An extension page's own origin as Chrome shows it (docs/extensions.md,
// "Extension origins"). The page is served from the emulated origin,
// `https://<id>.invalid`, which the inject's stand-ins answer for; over
// them, the page reads `chrome-extension://<id>` in its `location`, in
// `document.URL`, `documentURI`, `baseURI` and `domain`, and in the URLs it
// reads back of its elements, responses and requests. (Its own origin,
// what its messages come from and what a message to it names, is the
// inject's: src/inject/dom/Client.ts `origin`.) Set as the page's
// document opens, after the inject's hooks went in; the inject itself
// keeps reading the emulated origin. These are the extension's own pages,
// whose code is the extension's: the getters read as natives by name and
// length, not by source.
import { displayExtensionURL } from '../origin';
import { natives } from './natives';

const { defineProperty, getOwnPropertyDescriptor } = natives;
const apply = natives.Reflect.apply;

/** a URL of an emulated origin as Chrome's; anything else as it is */
const shown = (value: string) =>
	value.includes('.invalid') ? displayExtensionURL(value) : value;

/** a getter named and sized as the native `get <name>` */
function getterLike(name: string, get: (this: unknown) => unknown) {
	return getOwnPropertyDescriptor(
		{
			get [name]() {
				return apply(get, this, []);
			},
		},
		name,
	)!.get!;
}

/** a method named and sized as `native` */
function methodLike(
	native: Function,
	run: (this: unknown, args: unknown[]) => unknown,
) {
	const method = {
		[native.name](...args: unknown[]) {
			return apply(run, this, [args]);
		},
	}[native.name];
	defineProperty(method, 'length', { value: native.length });
	return method;
}

/** `prototype[name]`'s getter, over the one there (the inject's), its URL shown */
function showGetter(
	prototype: object | undefined,
	name: string,
	show: (value: string) => string = shown,
) {
	const descriptor = prototype && getOwnPropertyDescriptor(prototype, name);
	const get = descriptor?.get;
	if (!get || !descriptor.configurable) return;
	defineProperty(prototype, name, {
		...descriptor,
		get: getterLike(name, function () {
			const value = apply(get, this, []);
			return typeof value === 'string' ? show(value) : value;
		}),
	});
}

// the members that read a URL back, by interface
const READBACKS: [string, string[]][] = [
	['Document', ['URL', 'documentURI']],
	['Node', ['baseURI']],
	['HTMLAnchorElement', ['href']],
	['HTMLAreaElement', ['href']],
	['HTMLBaseElement', ['href']],
	['HTMLLinkElement', ['href']],
	['HTMLImageElement', ['src', 'currentSrc']],
	['HTMLScriptElement', ['src']],
	['HTMLIFrameElement', ['src']],
	['HTMLFrameElement', ['src']],
	['HTMLEmbedElement', ['src']],
	['HTMLObjectElement', ['data']],
	['HTMLMediaElement', ['src', 'currentSrc']],
	['HTMLSourceElement', ['src']],
	['HTMLTrackElement', ['src']],
	['HTMLInputElement', ['src']],
	['HTMLFormElement', ['action']],
	['StyleSheet', ['href']],
	['Response', ['url']],
	['XMLHttpRequest', ['responseURL']],
	['EventSource', ['url']],
];

/** the parts of a chrome-extension:// URL as a Location reads them, or null for another URL */
function partsOf(href: string): Record<string, string> | null {
	const parts =
		/^(chrome-extension:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href);
	if (!parts) return null;
	return {
		href,
		origin: `${parts[1]}//${parts[2]}`,
		protocol: parts[1],
		host: parts[2],
		hostname: parts[2],
		port: '',
		pathname: parts[3] || '/',
		search: parts[4] && parts[4] !== '?' ? parts[4] : '',
		hash: parts[5] && parts[5] !== '#' ? parts[5] : '',
	};
}

/**
 * The page's `location` as a stand-in over the inject's: each member the
 * inject's, called on the inject's stand-in, but the URL's parts, which
 * read the page's own address shown (or `script`'s, an emulated service
 * worker's, as its WorkerLocation reads)
 */
function presentLocation(real: Location, script: string | undefined) {
	// the inject tags the real Location with its stand-in (src/inject/modules/Access.ts setGlobalProxy)
	let tag: PropertyKey | undefined;
	let inner: object | undefined;
	for (const key of natives.ownKeys(real)) {
		const descriptor = getOwnPropertyDescriptor(real, key);
		const value = descriptor && 'value' in descriptor ? descriptor.value : null;
		if (value && typeof value === 'object' && value !== real) {
			tag = key;
			inner = value as object;
		}
	}
	if (tag === undefined || !inner) return;
	const standIn = Object.create(Object.getPrototypeOf(inner)) as object;
	const own = (that: unknown) => (that === standIn ? inner : that);
	const innerHref = getOwnPropertyDescriptor(inner, 'href')?.get;
	const parts = () =>
		partsOf(
			shown(script ?? (innerHref ? String(apply(innerHref, inner, [])) : '')),
		);
	const valueOf = Object.prototype.valueOf;
	for (const key of natives.ownKeys(inner)) {
		const descriptor = getOwnPropertyDescriptor(inner, key)!;
		const name = String(key);
		const get = descriptor.get;
		if (get)
			descriptor.get = getterLike(name, function () {
				const shownParts = this === standIn ? parts() : null;
				return shownParts && name in shownParts
					? shownParts[name]
					: apply(get, own(this), []);
			});
		const set = descriptor.set;
		if (set)
			descriptor.set = getOwnPropertyDescriptor(
				{
					set [name](value: unknown) {
						apply(set, own(this), [value]);
					},
				},
				name,
			)!.set;
		const value = descriptor.value;
		if (typeof value === 'function' && value !== valueOf)
			descriptor.value = methodLike(value, function (args) {
				if (key === 'toString' && this === standIn) {
					const shownParts = parts();
					if (shownParts) return shownParts.href;
				}
				return apply(value, own(this), args);
			});
		defineProperty(standIn, key, descriptor);
	}
	defineProperty(real, tag, {
		value: standIn,
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

/**
 * Show the page's origin as Chrome's: its location, every member in
 * READBACKS and `document.domain` read the emulated origin's URLs as
 * `chrome-extension://` (an emulated service worker's location: `script`)
 */
export function presentExtensionPage(script?: string) {
	const global = globalThis as unknown as Record<
		string,
		{ prototype?: object } | undefined
	>;
	try {
		presentLocation(natives.location, script);
		for (const [name, members] of READBACKS)
			for (const member of members) showGetter(global[name]?.prototype, member);
		showGetter(global.Document?.prototype, 'domain', (domain) =>
			domain.replace(/^([a-p]{32})\.invalid$/, '$1'),
		);
	} catch (error) {
		console.error(
			'STomp: the extension page keeps its emulated origin:',
			error,
		);
	}
}
