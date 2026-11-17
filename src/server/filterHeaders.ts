import StompURL from '../StompURL';

const cspHeaders: string[] = [
	'Content-Security-Policy',
	'Content-Security-Policy-Report-Only',
	'X-Content-Security-Policy',
	'X-Content-Security-Policy-Report-Only',
	'X-WebKit-CSP',
	'X-WebKit-CSP-Report-Only',
];

// Access-Control-* answers pass: the worker applies the CORS protocol itself
// (cors.ts) and a page reads them as it would natively
const corsHeaders: string[] = [
	'Cross-Origin-Resource-Policy',
	'Cross-Origin-Opener-Policy',
	'Cross-Origin-Opener-Policy-Report-Only',
];

// headers that would bind the page to the proxy origin or reach past the
// frame: HSTS pins the proxy host, Clear-Site-Data wipes every proxied
// origin's state at once, COEP blocks the page's own subresources once CORP
// is gone (the worker applies the page's policy itself, and serves its own
// where the host's page is isolated: src/isolation.ts), a
// Document-Isolation-Policy would move the frame into an agent cluster of
// its own, away from the documents of its origin, an Origin-Agent-Cluster
// would key the proxy origin's own agent cluster for every proxied document
// (the inject keys each document's as its header asks: DocumentClient
// siteKeyed), the reporting headers
// would post proxy URLs to the site, and Set-Cookie was consumed by the
// cookie jar (the browser must not store it for the proxy origin too)
const bindingHeaders: string[] = [
	'Strict-Transport-Security',
	'Clear-Site-Data',
	'Cross-Origin-Embedder-Policy',
	'Cross-Origin-Embedder-Policy-Report-Only',
	'Document-Isolation-Policy',
	'Document-Isolation-Policy-Report-Only',
	'Origin-Agent-Cluster',
	'Report-To',
	'NEL',
	'Reporting-Endpoints',
	'Permissions-Policy',
	'Feature-Policy',
	'X-Content-Type-Options',
	'Set-Cookie',
	// the browser would fetch the rules it names by itself, past the worker,
	// and act on none (src/scriptRoutes.ts NO_SPECULATION)
	'Speculation-Rules',
];

const removeHeaders: string[] = [
	...cspHeaders,
	...corsHeaders,
	...bindingHeaders,
];

export declare type RouteTransform = (
	resource: StompURL,
	url: StompURL,
	/** the route kind of the request whose response is filtered */
	kind?: string,
) => string;

export declare type AdditionalFilter = (
	headers: Readonly<Headers>,
	filteredHeaders: Headers,
	url: StompURL,
) => void;

// A response may carry more than one Content-Type: two upstream headers,
// which the fetch Headers object joins into one value with ", ", or a single
// value a server wrote as a comma list. A resource has one Content-Type to
// the browser, so a joined value like "application/javascript, text/javascript"
// (seen on tiktok's sw.js) makes Chrome refuse a service worker or module
// script for an unsupported MIME type. The browser reads such a response by
// its last value that is a type at all (Fetch, "extract a MIME type":
// measured in Chrome 152 with application/octet-stream before
// application/javascript, which importScripts runs), and a value that names
// no charset keeps the one an earlier value of the same type named; a comma
// inside a quoted parameter is not a separator.
function singleContentType(value: string): string {
	const values: string[] = [];
	let quoted = false;
	let from = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '\\' && quoted) {
			i++;
			continue;
		}
		if (ch === '"') quoted = !quoted;
		else if (ch === ',' && !quoted) {
			values.push(value.slice(from, i).trim());
			from = i + 1;
		}
	}
	values.push(value.slice(from).trim());
	if (values.length === 1) return values[0];
	const essenceOf = (one: string) => one.split(';')[0].trim().toLowerCase();
	const charsetOf = (one: string) =>
		/;\s*charset\s*=\s*("[^"]*"|[^;\s]*)/i.exec(one)?.[1] ?? null;
	let type: string | null = null;
	let charset: string | null = null;
	for (const one of values) {
		const essence = essenceOf(one);
		if (!/^[^\s/]+\/[^\s/]+$/.test(essence) || essence === '*/*') continue;
		const named = charsetOf(one);
		if (type === null || essenceOf(type) !== essence) charset = named;
		else if (named !== null) charset = named;
		type = one;
	}
	// none of them is a type: the first, as it came
	if (type === null) return values[0];
	return charset !== null && charsetOf(type) === null
		? `${type};charset=${charset}`
		: type;
}

/**
 * The URL a Location (or Content-Location) names, null for none. A value
 * with bytes past ASCII is not a URL yet: Chrome escapes each such byte
 * as it is (`%E2%98%83` for a snowman a server sent as UTF-8, `%FF` for a
 * byte that is no text at all), where parsing the header as a string
 * would encode each byte as a character of its own
 */
export function locationURL(value: string, base: URL): URL | null {
	try {
		return new URL(
			value.replace(
				/[\x80-\xff]/g,
				(byte) => `%${byte.charCodeAt(0).toString(16).toUpperCase()}`,
			),
			base,
		);
	} catch (error) {
		return null;
	}
}

// native as in the browser requesting an image from /binary/ or document from /html/
export function filterNativeRequestHeaders(
	headers: Readonly<Headers>,
	url: StompURL,
	additionalFilter: AdditionalFilter | void,
): Headers {
	const filteredHeaders = new Headers(headers);

	if (additionalFilter) {
		additionalFilter(headers, filteredHeaders, url);
	}

	return filteredHeaders;
}

export function filterResponseHeaders(
	headers: Readonly<Headers>,
	url: StompURL,
	transformRoute: RouteTransform,
	additionalFilter: AdditionalFilter | void,
): Headers {
	const filteredHeaders = new Headers(headers);

	for (const name of ['location', 'content-location']) {
		// (not a URL: left as it is)
		const target = headers.has(name)
			? locationURL(headers.get(name)!, url.url)
			: null;
		if (target)
			try {
				filteredHeaders.set(
					name,
					transformRoute(new StompURL(target, url), url),
				);
			} catch (error) {
				// no route for it: left as it is
			}
	}

	for (const header of removeHeaders) {
		filteredHeaders.delete(header);
	}

	const contentType = filteredHeaders.get('content-type');
	if (contentType !== null) {
		const single = singleContentType(contentType);
		if (single !== contentType) filteredHeaders.set('content-type', single);
	}

	if (additionalFilter) {
		additionalFilter(headers, filteredHeaders, url);
	}

	return filteredHeaders;
}
