import GenericCodec from './Codecs';
import { assetName, type Config } from './config';
import StompURL from './StompURL';

export const ROUTE_PROTOCOLS = ['http:', 'https:'];

/**
 * blob: URLs name the origin of the realm that made them, which is the
 * proxy's. The page is shown them under its real origin (the ObjectURL
 * module), so everything the page hands back is mapped to the proxy's form
 * here, where every URL a page gives an API passes. Set once per inject
 * bundle by the client; the service worker never sees a blob: URL. A blob:
 * URL of another real origin stays as it is and does not resolve, as the
 * browser refuses a blob: URL across origins.
 */
let blobOrigins: { page: string; proxy: string } | null = null;

export function setBlobOrigins(page: string, proxy: string) {
	blobOrigins = page === proxy ? null : { page, proxy };
}

/** the origins setBlobOrigins took, `[page, proxy]`, or null (the rewriter library is told them per call) */
export function blobOriginPair(): [string, string] | null {
	return blobOrigins ? [blobOrigins.page, blobOrigins.proxy] : null;
}

/** a page-origin blob: URL as the proxy's; anything else as it is */
export function proxyBlobURL(url: string): string {
	if (!blobOrigins || !url.startsWith(`blob:${blobOrigins.page}/`)) return url;
	return `blob:${blobOrigins.proxy}${url.slice(blobOrigins.page.length + 5)}`;
}

/** a proxy-origin blob: URL as the page's; anything else as it is */
export function pageBlobURL(url: string): string {
	if (!blobOrigins || !url.startsWith(`blob:${blobOrigins.proxy}/`)) return url;
	return `blob:${blobOrigins.page}${url.slice(blobOrigins.proxy.length + 5)}`;
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
 */
export function unwrapRoute(url: URL, codec: GenericCodec): URL | null {
	let real: URL | null = null;
	let href = url.href;
	for (let depth = 0; depth < 8; depth++) {
		let scope: string | undefined;
		for (const candidate of routeScopes)
			if (href.startsWith(candidate)) scope = candidate;
		if (!scope) break;
		const rest = href.slice(scope.length);
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

export function routeURL(resourceType: string, url: StompURL) {
	if (!ROUTE_PROTOCOLS.includes(url.url.protocol)) {
		// url is out of the scope of Stomp (a page-origin blob: URL becomes
		// the proxy's, which is the one the browser knows)
		return proxyBlobURL(url.toString());
	}

	// a URL that is already a route (the page read its raw proxy URL through
	// a path the rewriter missed) is routed as the real URL it stands for:
	// routed again it would decode to the proxy's own origin, refused
	const real = routeScopes.size ? unwrapRoute(url.url, url.codec) : null;
	if (real) url = new StompURL(real, url);

	return `${url.directory}${resourceType}/${url.encode()}`;
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

export function injectDocumentJS(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${assetName(config?.assets, 'injectDocument')}`;
}

export function injectWorkerJS(url: StompURL, config?: Config) {
	return `${assetBase(url, config)}${assetName(config?.assets, 'injectWorker')}`;
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
	resource: string;
	url: StompURL;
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

	const resource = path.slice(0, split);
	// every codec escapes `?`, so a literal one starts a query the browser put
	// after the route: a GET form submitted to a document's own address (a
	// form without an action) replaces that URL's query with its fields
	const query = path.indexOf('?', split + 1);
	const encoded =
		query === -1 ? path.slice(split + 1) : path.slice(split + 1, query);
	const decoded = codec.decode(encoded);
	const url = new URL(decoded);
	if (query !== -1) url.search = path.slice(query);

	url.hash = hashIndex === -1 ? '' : routed.slice(hashIndex);

	return {
		resource: resource,
		url: new StompURL(url, codec, directory),
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
