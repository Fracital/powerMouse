import type { RawHeaders } from '@mercuryworkshop/proxy-transports';
import { capitalizeHeader } from '../headers';
import { blinkHeaderMapOrder } from './blinkHeaderMap';
import {
	isHintName,
	NAVIGATION_HINT_ORDER,
	SUBRESOURCE_HINT_ORDER,
} from './hintNames';

/**
 * The request fields as Chrome puts them on the wire, so a request through
 * the proxy carries the field order (and the JA4H fingerprint) of the
 * browser the page runs in. Measured against Chrome 152 over HTTP/1.1 and
 * HTTP/2 (docs/fingerprint.md); the order is the same in both, HTTP/1.1
 * puts Host and Connection first (the transport adds those).
 *
 * A document's fields come from the browser process in a fixed order, the
 * client hints first in the order it adds them. A subresource's first group
 * comes from Blink's header map (the page's own fields, client hints,
 * User-Agent), then Accept, the rest from the network stack (Sec-Fetch-*,
 * Referer, Accept-Encoding, Accept-Language, Cookie, Priority). Blink's map
 * iterates in hash order (blinkHeaderMap.ts), so the page's own fields and
 * the hints a site asked for land among the defaults in an order that
 * depends on the whole set; the map is rebuilt here to get it. The page's
 * own fields are taken to be set before the hints (only a collision of two
 * hashes makes their order matter).
 */

/** what a request is, as far as its field order goes */
export interface RequestShape {
	/** a document, iframe or frame navigation */
	navigation: boolean;
	/** Sec-Fetch-Dest */
	destination: string;
	/** Sec-Fetch-Mode */
	mode: string;
	method: string;
	/** the request's cache mode, which Chrome's network stack spells as fields */
	cache?: RequestCache;
}

// fields that lead, before either group
const LEAD = ['content-length', 'pragma', 'cache-control'];

const NAVIGATION_FIRST = [
	...NAVIGATION_HINT_ORDER,
	'upgrade-insecure-requests',
	'content-type',
	'user-agent',
	'origin',
	'accept',
];

// what the network stack adds, in its order, after everything else
const NETWORK = [
	'sec-fetch-site',
	'sec-fetch-mode',
	'sec-fetch-user',
	'sec-fetch-dest',
	'sec-fetch-storage-access',
	'referer',
	'accept-encoding',
	'accept-language',
	'cookie',
	'priority',
];

/** what Chrome offers; a transport that decodes less says so (serveTransport) */
export const CHROME_ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

/**
 * The Priority field Chrome sends over HTTP/2 and HTTP/3 (RFC 9218), by
 * destination, as it sends it for a load with the default priority: a
 * document and its frames u=0, i; a stylesheet and a font u=0; fetch and
 * XHR u=1, i; an image i (urgency 3); a beacon or report u=4, i. A script
 * sends none (urgency 3, not incremental, the default): Chrome raises
 * parser-blocking scripts to u=1, which the worker cannot tell from the
 * async and module scripts most pages load.
 */
export function chromePriority(shape: RequestShape): string | null {
	if (shape.navigation) return 'u=0, i';
	switch (shape.destination) {
		case 'style':
		case 'font':
			return 'u=0';
		case 'script':
		case 'sharedworker':
		case 'worker':
		case 'serviceworker':
			return null;
		case 'image':
		case 'audio':
		case 'video':
		case 'track':
			return 'i';
		case 'report':
			return 'u=4, i';
		default:
			return 'u=1, i';
	}
}

/** Chrome's spelling: client hints and Priority lowercase, the rest title case */
function chromeCase(name: string): string {
	if (isHintName(name) || name.startsWith('sec-ch-') || name === 'priority')
		return name;
	const standard = capitalizeHeader(name);
	if (standard !== name) return standard;
	return name.replace(/(^|-)([a-z])/g, (_, dash, c) => dash + c.toUpperCase());
}

/**
 * `headers` as Chrome would send them for a request of this shape, with
 * Accept-Encoding and Priority added as Chrome adds them.
 */
export function chromeOrderedHeaders(
	headers: Headers,
	shape: RequestShape,
): RawHeaders {
	const fields = new Map<string, string>();
	for (const [name, value] of headers) fields.set(name, value);
	fields.set('accept-encoding', CHROME_ACCEPT_ENCODING);
	// a revalidating load (fetch's no-cache, a reload, a form's POST
	// navigation) asks for max-age=0; one that bypasses the cache (a hard
	// reload, no-store) for no-cache, with the HTTP/1.0 Pragma
	if (!fields.has('cache-control')) {
		if (shape.cache === 'reload' || shape.cache === 'no-store') {
			fields.set('cache-control', 'no-cache');
			if (!fields.has('pragma')) fields.set('pragma', 'no-cache');
		} else if (
			shape.cache === 'no-cache' ||
			(shape.navigation && shape.method === 'POST')
		)
			fields.set('cache-control', 'max-age=0');
	}
	const priority = chromePriority(shape);
	if (priority !== null && !fields.has('priority'))
		fields.set('priority', priority);

	const out: RawHeaders = [];
	const take = (name: string) => {
		const value = fields.get(name);
		if (value === undefined) return;
		out.push([chromeCase(name), value]);
		fields.delete(name);
	};
	const network = new Set(NETWORK);
	LEAD.forEach(take);
	if (shape.navigation) {
		NAVIGATION_FIRST.forEach(take);
		// anything else, before the network stack's fields
		for (const name of [...fields.keys()]) if (!network.has(name)) take(name);
	} else {
		// Blink sets Origin in its map for a CORS load an element starts (a
		// module script, a crossorigin image); for a fetch or an XHR
		// (destination empty) and for any other method the network stack
		// adds it, after Accept (measured: browserleaks' HTTP/2 page,
		// field-order suite)
		const blinkOrigin =
			shape.mode === 'cors' &&
			shape.destination !== 'empty' &&
			(shape.method === 'GET' || shape.method === 'HEAD');
		const mapped: string[] = [];
		if (blinkOrigin && fields.has('origin')) mapped.push('origin');
		for (const name of fields.keys())
			if (
				!network.has(name) &&
				name !== 'origin' &&
				name !== 'accept' &&
				name !== 'user-agent' &&
				!isHintName(name)
			)
				mapped.push(name);
		for (const name of SUBRESOURCE_HINT_ORDER)
			if (fields.has(name)) mapped.push(name);
		if (fields.has('user-agent')) mapped.push('user-agent');
		blinkHeaderMapOrder(mapped).forEach(take);
		take('accept');
		take('origin');
	}
	NETWORK.forEach(take);
	// nothing is dropped
	for (const name of [...fields.keys()]) take(name);
	return out;
}
