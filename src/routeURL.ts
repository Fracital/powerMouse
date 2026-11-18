import GenericCodec from './Codecs';
import { assetName, type Assets, type Config } from './config';
import {
	CACHE_MARK,
	MARKED_KINDS,
	realmCacheMark,
	splitCacheMark,
} from './memoryMark';
import { splitIntegrityMark } from './sri';
import StompURL, { openFragment, sealedFragmentText } from './StompURL';
import { withQuery } from './urlShape';
import { BUILD, CORE, DOCUMENT, DOCUMENT_FULL, LIBRARY } from './version';
import { decodeLinkRoute, LINK_SEGMENT } from './visited';

export { openFragment, sealedFragmentText };

export const ROUTE_PROTOCOLS = ['http:', 'https:'];

/**
 * blob: URLs name the origin of the realm that made them, which is the
 * proxy's. The page is shown them under its real origin (the ObjectURL
 * module), so everything the page hands back is mapped to the proxy's form
 * here, where every URL a page gives an API passes. Set once per inject
 * bundle by the client; the service worker never sees a blob: URL. A blob:
 * URL of another real origin stays as it is and does not resolve, as the
 * browser refuses a blob: URL across origins.
 *
 * A page of the proxy's own origin (proxy-ception, docs/proxyception.md)
 * would have the two forms alike, and every blob: URL of the real origin
 * (the host's, another site's private copies) would resolve for it as one
 * it was shown. So its form differs in the UUID instead: each hex digit
 * but the version's is flipped by a stream drawn from the codec's key
 * (`flip`, its own inverse), and a URL of the browser's form it hands back
 * names a Blob that is not there, as another origin's does.
 */
let blobOrigins: { page: string; proxy: string; flip?: string } | null = null;

export function setBlobOrigins(page: string, proxy: string, key = '') {
	blobOrigins =
		page !== proxy
			? { page, proxy }
			: key && page
				? { page, proxy, flip: key }
				: null;
}

/** what setBlobOrigins took, `[page, proxy]` and the key of a page of the proxy's origin, or null (the rewriter library is told them per call) */
export function blobOriginPair(): [string, string, string?] | null {
	if (!blobOrigins) return null;
	const { page, proxy, flip } = blobOrigins;
	return flip ? [page, proxy, flip] : [page, proxy];
}

/** the UUID of a blob: URL's path (`/<uuid>...`) flipped by `key`, the rest as it is */
function flipUUID(rest: string, key: string): string {
	if (!/^\/[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}/.test(rest)) return rest;
	// FNV-1a of the key, then a xorshift stream: a nibble a digit
	let state = 0x811c9dc5;
	for (let i = 0; i < key.length; i++)
		state = Math.imul(state ^ key.charCodeAt(i), 0x01000193);
	let out = '/';
	for (let i = 1; i < 37; i++) {
		const char = rest[i];
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		// the version digit (4) stays, the variant keeps its two top bits
		const mask = char === '-' || i === 15 ? 0 : i === 20 ? 3 : 15;
		// never the digit itself everywhere: one flip at least
		const flip = (state >>> 4) & mask || (i === 1 ? 1 : 0);
		out += char === '-' ? char : (parseInt(char, 16) ^ flip).toString(16);
	}
	return out + rest.slice(37);
}

/** a page-origin blob: URL as the proxy's; anything else as it is */
export function proxyBlobURL(url: string): string {
	if (!blobOrigins || !url.startsWith(`blob:${blobOrigins.page}/`)) return url;
	const rest = url.slice(blobOrigins.page.length + 5);
	return `blob:${blobOrigins.proxy}${blobOrigins.flip ? flipUUID(rest, blobOrigins.flip) : rest}`;
}

/** a proxy-origin blob: URL as the page's; anything else as it is */
export function pageBlobURL(url: string): string {
	if (!blobOrigins || !url.startsWith(`blob:${blobOrigins.proxy}/`)) return url;
	const rest = url.slice(blobOrigins.proxy.length + 5);
	return `blob:${blobOrigins.page}${blobOrigins.flip ? flipUUID(rest, blobOrigins.flip) : rest}`;
}

/** the browser's UUID of a blob: URL a page of `origin` names by `uuid` (the service worker: BLOB_ROUTE) */
export function proxyBlobUUID(
	uuid: string,
	origin: string,
	proxy: string,
	key: string,
): string {
	return origin === proxy ? flipUUID(`/${uuid}`, key).slice(1) : uuid;
}

/**
 * The proxy's origins besides the realm's own that a config names: with the
 * site pool (docs/site-pool.md) a slot's hub, the hub's controller when that
 * is a frame of another origin (isolation mode: SitesConfig.home) and every
 * slot (Config.sites), or a hub's slots (Config.slotOrigins). A route on one
 * is a route, and a route to one is the proxy's own origin. Never a reason
 * to treat one as the document's origin: the slots are other origins to the
 * emulated same-origin policy.
 */
export function proxyOrigins(config: Pick<Config, 'sites' | 'slotOrigins'>) {
	const sites = config.sites;
	return [
		...(sites
			? [
					sites.hub,
					...(sites.home && sites.home !== sites.hub ? [sites.home] : []),
					...(sites.origins ?? []),
				]
			: []),
		...(config.slotOrigins ?? []),
	];
}

/**
 * Where routes live, as `<proxy origin><scope>`: the realm's own (the
 * client's) or every controller's (the service worker's). A URL under one
 * of them is already a route.
 */
const routeScopes = new Set<string>();

export function addRouteScope(origin: string, scope: string) {
	routeScopes.add(`${origin}${scope}`);
}

/** every route scope known here, as `<origin><scope>` (a rewrite worker is told the service worker's) */
export function routeScopeList(): string[] {
	return [...routeScopes];
}

/** take on route scopes as routeScopeList gave them */
export function addRouteScopes(scopes: string[]) {
	for (const scope of scopes) routeScopes.add(scope);
}

/** the route scopes as routeScopeList gave them, and no others (the rewriter library, for each caller) */
export function setRouteScopes(scopes: string[]) {
	routeScopes.clear();
	addRouteScopes(scopes);
}

/**
 * The real URL a route of a known scope stands for, through any depth (a
 * route of a route of a URL is that URL), with the outermost hash; null when
 * `url` is not a route. Any controller id and any kind of the scope; decoded
 * with `codec`, so a foreign controller's route with another codec stays as
 * it is. An inline document's address names a token, not a URL.
 *
 * A codec without a key (plain, base64) decodes every controller's routes
 * alike, a STomp's the page runs among them (proxy-ception,
 * docs/proxyception.md), whose routes are of the proxy's origin too: given
 * `own`, the caller's address (`/stomp/<id>/`, or with its origin), such a
 * codec takes only routes of that id for its own, and leaves another id's
 * (and a link's route, which names none) to the STomp that made them.
 */
export function unwrapRoute(
	url: URL,
	codec: GenericCodec,
	own?: string,
): URL | null {
	let real: URL | null = null;
	let href = url.href;
	for (let depth = 0; depth < 8; depth++) {
		let scope: string | undefined;
		for (const candidate of routeScopes)
			if (href.startsWith(candidate)) scope = candidate;
		if (!scope) break;
		const rest = href.slice(scope.length);
		// (a link's route names no controller: with such a codec it is the
		// inner STomp's as likely as this one's, and a link of this one's
		// reaches its worker by its own route, never as a route of a route)
		if (!codec.key && own !== undefined) {
			const ownId = addressId(own, scope);
			const id = /^([\w-]+)\//.exec(rest)?.[1];
			if (
				ownId &&
				(rest.startsWith(`${LINK_SEGMENT}/`) || (id && id !== ownId))
			)
				break;
		}
		// a link's route (src/visited.ts): the context, a space, the URL
		if (rest.startsWith(`${LINK_SEGMENT}/`)) {
			const link = linkRouteURL(rest.slice(LINK_SEGMENT.length + 1), codec);
			if (!link) break;
			real = link;
			href = link.href;
			continue;
		}
		// `<id>/<kind>/<encoded>`, or `<kind>/<encoded>` where the scope is the
		// controller's directory (a config from before addresses)
		const id = /^([\w-]+)\//.exec(rest)?.[1];
		const directories = id ? [`${scope}${id}/`, scope] : [scope];
		let next: URL | null = null;
		for (const directory of directories) {
			if (href.slice(directory.length).startsWith('inline:')) break;
			try {
				const parsed = parseRoutedURL(href, codec, directory).url.url;
				if (ROUTE_PROTOCOLS.includes(parsed.protocol)) {
					next = parsed;
					break;
				}
			} catch {
				// not a route of this directory
			}
		}
		if (!next) break;
		real = next;
		href = next.href;
	}
	return real;
}

/** the controller id of the address `own` under `scope` (`<origin><scope>`), or null */
function addressId(own: string, scope: string): string | null {
	let path: string;
	try {
		path = new URL(own, scope).pathname;
	} catch {
		return null;
	}
	const scopePath = new URL(scope).pathname;
	if (!path.startsWith(scopePath)) return null;
	return /^([\w-]+)\/$/.exec(path.slice(scopePath.length))?.[1] ?? null;
}

/**
 * The real URL of a link route's part after `<scope>~/` (src/visited.ts,
 * which parses the context as well), with its fragment; null when it does
 * not decode to one
 */
export const linkRouteURL = (rest: string, codec: GenericCodec): URL | null =>
	decodeLinkRoute(rest, codec)?.url ?? null;

/**
 * In a page or a worker: the route of a blob: URL (the browser's form) a
 * load of `kind` takes when the page's bytes in it were never rewritten
 * (src/inject/modules/ObjectURL.ts), or null to load it as it is. `given`
 * is the URL as the page gave it.
 */
let blobRoute:
	((kind: string, href: string, given: string) => string | null) | null = null;
/**
 * One per bundle: the realm that runs it sets it, another realm the bundle
 * hooks (a javascript: or about:blank frame of the page's) only when none
 * is set, as its client goes with its frame
 */
export function setBlobRoute(route: typeof blobRoute, own: boolean) {
	if (own || !blobRoute) blobRoute = route;
}

export function routeURL(resourceType: string, url: StompURL) {
	if (!ROUTE_PROTOCOLS.includes(url.url.protocol)) {
		// url is out of the scope of STomp (a page-origin blob: URL becomes
		// the proxy's, which is the one the browser knows)
		const given = url.toString();
		const href = proxyBlobURL(given);
		return (
			(href.startsWith('blob:') && blobRoute?.(resourceType, href, given)) ||
			href
		);
	}

	// a URL that is already a route (the page read its raw proxy URL through
	// a path the rewriter missed) is routed as the real URL it stands for:
	// routed again it would be the proxy's own route fetched as a site's
	const real = routeScopes.size
		? unwrapRoute(url.url, url.codec, url.directory)
		: null;
	if (real) url = new StompURL(real, url);

	// what a renderer's memory cache keeps carries its document's site's
	// mark (src/memoryMark.ts)
	const mark = MARKED_KINDS.has(resourceType)
		? (url.mark ?? realmCacheMark())
		: '';
	return `${url.directory}${resourceType}${mark ? CACHE_MARK + mark : ''}/${url.encode(isDocumentKind(resourceType))}`;
}

/**
 * The name of the one entry a GET form's submission carries through the
 * proxy (the inject's FormQuery module): its value is the form's query,
 * sealed, so the route reads `?=<sealed>`
 */
export const FORM_QUERY_NAME = '';

/**
 * The query a route's own query stands for (`?` and the text, as a URL's
 * `search`): a GET form's sealed query opened, anything else (a query the
 * browser wrote after the route as it was) as it is
 */
export function formQuery(codec: GenericCodec, search: string): string {
	const sealed = /^\?=([A-Za-z0-9_-]*)$/.exec(search);
	if (!sealed) return search;
	if (!sealed[1]) return '?';
	try {
		const query = codec.decode(sealed[1]);
		return query ? `?${query}` : search;
	} catch (error) {
		return search;
	}
}

/** whether routes of `kind` are documents (src/rewriteHTML.ts routeHTML), whose fragment is sealed */
export function isDocumentKind(kind: string): boolean {
	return kind === 'html' || kind.startsWith('html:');
}

/**
 * Raw binary data
 */
export function routeBinary(resource: StompURL) {
	if (resource.url.protocol === 'data:') {
		return resource.toString();
	}

	return routeURL('binary', resource);
}

/**
 * A srcset or picture candidate: binary data too, under its own kind, since
 * Chrome blocks an insecure one where it upgrades an insecure `src`
 * (src/mixedContent.ts) and the worker sees the destination `image` for both
 */
export function routeImageSet(resource: StompURL) {
	if (resource.url.protocol === 'data:') {
		return resource.toString();
	}

	return routeURL('binary:set', resource);
}

/**
 * navigator.postBeacon request
 */
export function routeXHR(resource: StompURL) {
	if (resource.url.protocol === 'data:') {
		return resource.toString();
	}

	return routeURL('xhr', resource);
}

/**
 * The route of a request a page's policy refused (src/server/rewrites.ts),
 * and of an EventSource's, which a network error would have reconnect
 */
export const REFUSED_ROUTE = 'refused';
export const REFUSED_SOURCE_ROUTE = 'refusedsource';

/**
 * Where a worker's request its policy refuses goes instead (a fetch, an
 * XMLHttpRequest, an EventSource, an import, a worker): the service worker
 * answers it with a network error, so the browser fails it as it fails a
 * refused one, with its own error, and an error that names the route
 * names `resource` (a local scheme's names no URL)
 */
export function routeRefused(resource: StompURL, eventSource = false) {
	return routeURL(
		eventSource ? REFUSED_SOURCE_ROUTE : REFUSED_ROUTE,
		ROUTE_PROTOCOLS.includes(resource.url.protocol)
			? resource
			: new StompURL(new URL('http://refused.invalid/'), resource),
	);
}

/**
 * Where the bundles live for a routed URL: its directory is the controller's
 * address (`/stomp/<id>/`, with or without the origin in front), the assets
 * are served from the scope (`/stomp/`), so the address is swapped for the
 * scope and whatever preceded it is kept. Without a scope (an old config)
 * the directory is the scope.
 */
function assetBase(url: StompURL, config?: Config): string {
	const { directory } = url;
	if (
		!config?.scope ||
		!config.directory ||
		!directory.endsWith(config.directory)
	)
		return directory;
	return `${directory.slice(0, -config.directory.length)}${config.scope}`;
}

/**
 * Only the aes and base64 codecs read crypto-js, so only they load the full
 * inject bundle, which carries it (build.js, src/cryptoStub.ts); the xor and
 * generic codecs load the crypto-free injectDocument/injectWorker. A call
 * with no config takes the crypto-free bundle: the controller defaults to the
 * xor codec, and a document a shell makes always carries its config.
 */
function cryptoInject(config?: Config): boolean {
	return config?.codec === 'aes' || config?.codec === 'base64';
}

/** the document bundle this realm was loaded from: its file's name and its query (ownDocumentBundle) */
let ownBundle: { name: string; query: string } | null = null;

/**
 * Note the URL a document bundle was loaded from (src/inject/dom/entry.ts):
 * a shell this realm makes (a srcdoc frame's, a document it writes) names
 * the same file of the same build, as the service worker's shell named it,
 * whichever service worker is now in charge
 */
export function ownDocumentBundle(src: string) {
	try {
		const { pathname, search } = new URL(src);
		ownBundle = {
			name: pathname.slice(pathname.lastIndexOf('/') + 1),
			query: search,
		};
	} catch (error) {
		// no URL: the build's own name, below
	}
}

/**
 * The document bundle's file for `config`, as a shell names it
 * (injectDocumentJS): its name and its hash (version.ts DOCUMENT), which a
 * host may let browsers keep for good and the service worker keeps
 * (serviceWorker.ts documentBundle), so no document waits for a
 * revalidation of it before its first script
 */
export function injectDocumentFile(config?: Config) {
	const full = cryptoInject(config);
	const name = assetName(
		config?.assets,
		full ? 'injectDocumentFull' : 'injectDocument',
	);
	if (ownBundle?.name === name) return `${name}${ownBundle.query}`;
	const hash = full ? DOCUMENT_FULL : DOCUMENT;
	return hash ? `${name}?${encodeURIComponent(hash)}` : name;
}

export function injectDocumentJS(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${injectDocumentFile(config)}`;
}

export function injectWorkerJS(url: StompURL, config?: Config) {
	const key = cryptoInject(config) ? 'injectWorkerFull' : 'injectWorker';
	return `${assetBase(url, config)}${assetName(config?.assets, key)}`;
}

/**
 * The light rewriter library asset (a top's shell loads it,
 * src/rewriteHTML.ts; a worker or sandboxed frame fetches it,
 * src/inject/rewriter.ts), by the URL the controller fetched it with when it
 * started: the same cache entry
 */
export function rewriterLibJS(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${libraryFile(config?.assets)}`;
}

/**
 * The rewriter's wasm core module, by the URL the controller fetched it with
 * (src/controller/index.ts), so a page's synchronous fetch of it on a cold
 * rewrite (src/inject/rewriter.ts) is answered from the HTTP cache
 */
export function coreWasm(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${coreFile(config?.assets)}`;
}

/**
 * The core module's file as it is asked for: its name and its hash
 * (version.ts CORE), so that a host may let browsers keep it for good and
 * a top's synchronous fetch of it is answered by the HTTP cache without a
 * revalidation round trip to the host
 */
export function coreFile(assets?: Assets) {
	return `${assetName(assets, 'core')}?${encodeURIComponent(CORE)}`;
}

/** the rewriter library's file as it is asked for: its name and its build's hash */
export function libraryFile(assets?: Assets) {
	return `${assetName(assets, 'rewriterLib')}?${encodeURIComponent(LIBRARY)}`;
}

/** the WebRTC worker's script, and the stack's wasm module it loads (docs/webrtc-over-wisp.md) */
export function rtcWorkerJS(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${assetName(config?.assets, 'rtcWorker')}`;
}
export function rtcModule(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${assetName(config?.assets, 'rtc')}`;
}
/** the WebRTC stand-in library (src/inject/dom/rtcStack.ts), asked for by this build */
export function rtcStackJS(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${assetName(config?.assets, 'rtcStack')}?${encodeURIComponent(BUILD)}`;
}

export function geckoXHR(url: StompURL) {
	return `${url.directory}gxhr`;
}

export function queueXHR(url: StompURL) {
	return `${url.directory}xhr`;
}

/*
// url will not be unrouted
// always store original url
 export function unrouteBinary(url) {
	if (url.url.protocol === 'data:') {
		return url.toString();
	}

	return parseRoutedURL()
}*/

export interface ParsedRoutedURL {
	/** the route's kind, without its integrity and cache marks */
	resource: string;
	url: StompURL;
	/** the integrity the load carries (src/sri.ts), '' for none */
	integrity: string;
	/** the cache mark of the document that routed it (src/memoryMark.ts), '' for none */
	cacheMark: string;
}

export function parseRoutedURL(
	routed: string,
	codec: GenericCodec,
	directory: string,
): ParsedRoutedURL {
	if (!routed.startsWith(directory)) {
		throw new Error('Outside directory');
	}

	const hashIndex = routed.indexOf('#');

	const path =
		hashIndex === -1
			? routed.slice(directory.length)
			: routed.slice(directory.length, hashIndex);

	const split = path.indexOf('/');

	if (split === -1) {
		throw new Error('Invalid route');
	}

	const [marked, integrity] = splitIntegrityMark(path.slice(0, split));
	const [resource, cacheMark] = splitCacheMark(marked);
	// every codec escapes `?`, so a literal one starts a query the browser put
	// after the route: a GET form submitted to a document's own address (a
	// form without an action) replaces that URL's query with its fields
	const query = path.indexOf('?', split + 1);
	const encoded =
		query === -1 ? path.slice(split + 1) : path.slice(split + 1, query);
	const decoded = codec.decode(encoded);
	let url = new URL(decoded);
	// as written: a query of `?` alone is an empty one (src/urlShape.ts); a
	// GET form's sealed query opened (formQuery)
	if (query !== -1) url = withQuery(url, formQuery(codec, path.slice(query)));

	if (hashIndex !== -1) {
		const fragment = routed.slice(hashIndex + 1);
		url.hash = `#${isDocumentKind(resource) ? openFragment(codec, fragment) : fragment}`;
	} else url.hash = '';

	return {
		resource: resource,
		url: new StompURL(url, codec, directory),
		integrity,
		cacheMark,
	};
}

export declare interface DataURI {
	attributes: string[];
	mime: string;
	data: string;
}

export function parseDataURI(pathname: string): DataURI {
	const comma = pathname.indexOf(',');
	const type = pathname.slice(0, comma);
	let data = pathname.slice(comma + 1);
	const [mime, ...attributes] = type.split(';');

	if (attributes.includes('base64')) {
		// the bytes are text (a script, a document, a stylesheet) in UTF-8;
		// atob alone gives one character per byte and mangles anything beyond
		// Latin-1
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		data = new TextDecoder().decode(bytes);
	} else {
		// RFC 2397 bodies are percent-encoded (Reddit ships scripts as
		// data:text/javascript,%7B...); the parser needs the real text
		try {
			data = decodeURIComponent(data);
		} catch {
			// not valid percent-encoding, keep the raw body
		}
	}

	return {
		mime,
		attributes,
		data,
	};
}

export function createDataURI(data: DataURI) {
	return `data:${[data.mime, ...data.attributes].join(';')},${
		data.attributes.includes('base64')
			? btoa(
					Array.from(new TextEncoder().encode(data.data), (byte) =>
						String.fromCharCode(byte),
					).join(''),
				)
			: encodeURIComponent(data.data)
	}`;
}
