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
];

// headers that would bind the page to the proxy origin or reach past the
// frame: HSTS pins the proxy host, Clear-Site-Data wipes every proxied
// origin's state at once, COEP blocks the page's own subresources once CORP
// is gone, the reporting headers would post proxy URLs to the site, and
// Set-Cookie was consumed by the cookie jar (the browser must not store it
// for the proxy origin too)
const bindingHeaders: string[] = [
	'Strict-Transport-Security',
	'Clear-Site-Data',
	'Cross-Origin-Embedder-Policy',
	'Report-To',
	'NEL',
	'Reporting-Endpoints',
	'Permissions-Policy',
	'Feature-Policy',
	'X-Content-Type-Options',
	'Set-Cookie',
];

const removeHeaders: string[] = [
	...cspHeaders,
	...corsHeaders,
	...bindingHeaders,
];

export declare type RouteTransform = (
	resource: StompURL,
	url: StompURL,
) => string;

export declare type AdditionalFilter = (
	headers: Readonly<Headers>,
	filteredHeaders: Headers,
	url: StompURL,
) => void;

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

	for (const name of ['location', 'content-location'])
		if (headers.has(name))
			try {
				filteredHeaders.set(
					name,
					transformRoute(
						new StompURL(new URL(headers.get(name)!, url.toString()), url),
						url,
					),
				);
			} catch (error) {
				// not a URL: leave it
			}

	for (const header of removeHeaders) {
		filteredHeaders.delete(header);
	}

	if (additionalFilter) {
		additionalFilter(headers, filteredHeaders, url);
	}

	return filteredHeaders;
}
