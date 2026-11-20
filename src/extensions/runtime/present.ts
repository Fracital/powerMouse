// An extension page's own origin as Chrome shows it (docs/extensions.md,
// "Extension origins"). The page is served from the emulated origin,
// `https://<id>.invalid`, which the inject's stand-ins answer for; over
// them, the page reads `chrome-extension://<id>` in its `location`, in
// `document.URL`, `documentURI`, `baseURI` and `domain`, and in the URLs it
// reads back of its elements, responses and requests. (Its own origin,
// what its messages come from and what a message to it names, is the
// inject's: src/inject/dom/Client.ts `origin`.) Set as the page's
// document opens, after the inject's hooks went in; the inject itself
// keeps reading the emulated origin. What the runtime defines here reads as
// native, by name, length and source (natives.ts masking).
import { displayExtensionOrigin, displayExtensionURL } from '../origin';
import { masking, natives } from './natives';

const { defineProperty, getOwnPropertyDescriptor } = natives;
const apply = natives.Reflect.apply;

/** a URL of an emulated origin as Chrome's (a blob: URL's too); anything else as it is */
export const shown = (value: string) =>
	value.includes('.invalid')
		? value.startsWith('blob:')
			? `blob:${displayExtensionURL(value.slice(5))}`
			: displayExtensionURL(value)
		: value;

/** a getter named, sized and shown as the native `get <name>` */
export function getterLike(name: string, get: (this: unknown) => unknown) {
	const getter = getOwnPropertyDescriptor(
		{
			get [name]() {
				return apply(get, this, []);
			},
		},
		name,
	)!.get!;
	masking.native(getter, `get ${name}`);
	return getter;
}

/** a setter named, sized and shown as the native `set <name>` */
export function setterLike(
	name: string,
	set: (this: unknown, value: unknown) => void,
) {
	const setter = getOwnPropertyDescriptor(
		{
			set [name](value: unknown) {
				apply(set, this, [value]);
			},
		},
		name,
	)!.set!;
	masking.native(setter, `set ${name}`);
	return setter;
}

/** a method named, sized and shown as `native` (a name and length) */
export function methodLike(
	native: { name: string; length: number },
	run: (this: unknown, args: unknown[]) => unknown,
) {
	const method = {
		[native.name](...args: unknown[]) {
			return apply(run, this, [args]);
		},
	}[native.name];
	defineProperty(method, 'length', { value: native.length });
	masking.native(method, native.name);
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
	['Request', ['url', 'referrer']],
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
			descriptor.set = setterLike(name, function (value) {
				apply(set, own(this), [value]);
			});
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
 * A link's parts (an `<a>`'s, an `<area>`'s) as the URL its `href` shows
 * reads them; another URL's, and a blob: URL's but its origin, as the
 * inject's read them
 */
function showLinkParts(prototype: object | undefined) {
	const href = prototype && getOwnPropertyDescriptor(prototype, 'href')?.get;
	if (!href) return;
	for (const name of ['origin', 'protocol', 'host', 'hostname']) {
		const descriptor = getOwnPropertyDescriptor(prototype, name);
		const get = descriptor?.get;
		if (!get || !descriptor.configurable) continue;
		defineProperty(prototype, name, {
			...descriptor,
			get: getterLike(name, function () {
				const parts = partsOf(String(apply(href, this, [])));
				const value = apply(get, this, []);
				return parts
					? parts[name]
					: name === 'origin' && typeof value === 'string'
						? displayExtensionOrigin(value)
						: value;
			}),
		});
	}
}

/**
 * Show the page's origin as Chrome's: its location, every member in
 * READBACKS, a link's parts, `document.domain` and the blob: URLs it makes
 * read the emulated origin's URLs as `chrome-extension://` (an emulated
 * service worker's location: `script`). A blob: URL in that form goes back
 * to the inject as its own (src/routeURL.ts proxyBlobURL).
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
		showLinkParts(global.HTMLAnchorElement?.prototype);
		showLinkParts(global.HTMLAreaElement?.prototype);
		showGetter(global.Document?.prototype, 'domain', (domain) =>
			domain.replace(/^([a-p]{32})\.invalid$/, '$1'),
		);
		const URLCtor = globalThis.URL;
		const create = getOwnPropertyDescriptor(URLCtor, 'createObjectURL');
		const made = create?.value as Function | undefined;
		if (made && create?.writable)
			defineProperty(URLCtor, 'createObjectURL', {
				...create,
				value: methodLike(made, function (args) {
					const url = apply(made, this, args);
					return typeof url === 'string' ? shown(url) : url;
				}),
			});
	} catch (error) {
		console.error(
			'STomp: the extension page keeps its emulated origin:',
			error,
		);
	}
}
