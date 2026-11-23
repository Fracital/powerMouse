import { pastASCII, utf8Text } from '../byteString';
import StompURL from '../StompURL';
import { BYTES_MARKER } from '../transport/messages';

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
// frame: HSTS pins the proxy host (the worker keeps the site's for its
// partition: hsts.ts), Clear-Site-Data wipes every proxied origin's state
// at once, COEP blocks the page's own subresources once CORP
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
	// the browser would block STomp's own scripts, and the page's, whose
	// integrity the worker checks itself: the worker applies it
	// (contentPolicies.ts integrityPolicyDestinations)
	'Integrity-Policy',
	'Integrity-Policy-Report-Only',
	// state the browser would keep for the proxy origin, every site's at
	// once, which nothing of STomp reads: a login status (the inject's FedCM
	// has its own), a storage access grant, a compression dictionary
	'Set-Login',
	'Activate-Storage-Access',
	'Use-As-Dictionary',
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
 * The URL a Location names, null for none. A value with bytes past ASCII
 * is not a URL yet: Chrome escapes each such byte as it is (`%E2%98%83`
 * for a snowman a server sent as UTF-8, `%FF` for a byte that is no text
 * at all), where parsing the header as a string would encode each byte as
 * a character of its own
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

/** the statuses whose Location the browser follows */
export const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

export function filterResponseHeaders(
	headers: Readonly<Headers>,
	status: number,
	url: StompURL,
	transformRoute: RouteTransform,
	additionalFilter: AdditionalFilter | void,
): Headers {
	const filteredHeaders = new Headers(headers);

	// Chrome follows a Location only for a redirect, and does nothing with
	// a Content-Location: a 201's Location, a 200's and every
	// Content-Location reach fetch() and XHR as the server sent them
	// (link-readback). A redirect's that is not a URL is left as it is
	const target =
		REDIRECT_STATUSES.includes(status) && headers.has('location')
			? locationURL(headers.get('location')!, url.url)
			: null;
	if (target)
		try {
			filteredHeaders.set(
				'location',
				transformRoute(new StompURL(target, url), url),
			);
		} catch (error) {
			// no route for it: left as it is
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

/** the parameters of a header value, split at each `;` outside quotes */
function parameters(value: string): string[] {
	const parts: string[] = [];
	let quoted = false;
	let from = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '\\' && quoted) i++;
		else if (ch === '"') quoted = !quoted;
		else if (ch === ';' && !quoted) {
			parts.push(value.slice(from, i));
			from = i + 1;
		}
	}
	parts.push(value.slice(from));
	return parts;
}

/** RFC 8187's value characters, every other byte of the UTF-8 escaped */
const extendedValue = (text: string) =>
	encodeURIComponent(text).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/**
 * The name Chrome gives a download from its URL when the response names
 * none it can read: the last path segment, its escapes read as UTF-8, or
 * the host for none
 */
function urlName(url: URL): string {
	const segment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
	return (segment && (utf8Text(unescape(segment)) ?? segment)) || url.hostname;
}

/**
 * A Content-Disposition as the browser has to read it to name a download as
 * it does natively, or null to keep it. Chrome takes `filename*`, else
 * reads `filename`'s bytes as UTF-8, and names a file whose bytes are not
 * UTF-8 from its URL (net::HttpContentDisposition; measured with Chrome
 * 157). The bytes would reach it encoded again (BYTES_MARKER), so the name
 * goes as a `filename*` of ASCII. A navigation's with no name at all gets
 * its URL's, or the browser would name the file after the route.
 */
function browserDisposition(
	value: string,
	url: URL,
	navigation: boolean,
): string | null {
	const parts = parameters(value);
	const key = (part: string) =>
		part
			.slice(0, part.indexOf('=') >>> 0)
			.trim()
			.toLowerCase();
	if (parts.some((part) => key(part) === 'filename*')) {
		// a raw filename is not read beside it
		const kept = parts.filter(
			(part) => key(part) !== 'filename' || !pastASCII(part),
		);
		return kept.length === parts.length ? null : kept.join(';');
	}
	const plain = parts.findIndex((part, i) => i > 0 && key(part) === 'filename');
	let name: string;
	if (plain !== -1) {
		const part = parts[plain];
		if (!pastASCII(part)) return null;
		const raw = part
			.slice(part.indexOf('=') + 1)
			.trim()
			.replace(/^"((?:[^"\\]|\\.)*)"?$/, (all, quoted: string) =>
				quoted.replace(/\\(.)/g, '$1'),
			);
		name = utf8Text(raw) ?? urlName(url);
		parts.splice(plain, 1);
	} else if (navigation) name = urlName(url);
	else return null;
	return [...parts, ` filename*=UTF-8''${extendedValue(name)}`].join(';');
}

/**
 * The response's header values with bytes past 0x7F, as the page and the
 * browser read them natively. The transport hands each value over as a
 * byte string, a character a byte, which is what a page reads, but Chrome
 * encodes every header of a service worker's Response as UTF-8 again: the
 * bytes go to the inject in a mark (BYTES_MARKER), and Content-Disposition,
 * which the browser reads itself, as it would name the download.
 */
export function browserBytes(
	headers: Headers,
	url: URL,
	navigation: boolean,
): void {
	const sent: string[] = [];
	for (const [name, value] of [...headers]) {
		if (name === 'content-disposition') {
			const browser = browserDisposition(value, url, navigation);
			if (browser !== null) {
				headers.set(name, browser);
				sent.push(`${name}:${escape(value)}`);
				continue;
			}
		}
		// (a site's own Server-Timing is shown without the worker's marks)
		if (name !== 'server-timing' && /[\x80-\xff]/.test(value))
			sent.push(`${name}:${escape(value)}`);
	}
	if (sent.length)
		headers.append('server-timing', `${BYTES_MARKER};desc="${sent.join(' ')}"`);
}
