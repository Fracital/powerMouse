// Subresource integrity (an `integrity` attribute, a Link header's
// `integrity`) for the scripts and stylesheets STomp rewrites. The browser
// would hash the bytes it gets, which are the rewrite, and refuse a page's
// own correct hash; so the browser is never told the metadata. It rides in
// the route instead (a mark after the route's kind), and the service worker
// checks the origin's bytes against it, as the browser checks them natively:
// a mismatch, or a response the page could not read (another origin's
// without CORS), is a network error (src/server/integrity.ts).

/** what follows a route's kind when the load carries integrity metadata */
export const INTEGRITY_MARK = ';sri=';
/**
 * The mark's items for metadata that names nothing valid (`integrity=""`):
 * nothing is checked, and an import map's integrity does not apply either
 * (the element's own attribute stands, as natively)
 */
export const NO_INTEGRITY = 'none';
/**
 * The fragment of a refused stylesheet's route asked for again with the
 * page's metadata on the element: the worker answers a stylesheet request
 * that carries integrity with bytes that match none of it (./sriDigest.ts refusalBytes),
 * and the browser refuses them itself (no sheet, Chrome's own message;
 * DOMAttributes). Nothing of the origin's response is in them, so a page
 * that asks for such a URL itself learns nothing.
 */
export const REFUSED_FRAGMENT = '#stomp-sri-refused';
/** the route (under the directory) the inject gives a document's import map integrity on: [[module URL, metadata], ...] (server/integrityLoads.ts) */
export const IMPORT_MAP_ROUTE = 'sri/importmap';

export type Algorithm = 'sha256' | 'sha384' | 'sha512';

/** an algorithm by every name Chrome takes for it (lower case only) */
const ALGORITHMS: Record<string, Algorithm> = {
	sha256: 'sha256',
	'sha-256': 'sha256',
	sha384: 'sha384',
	'sha-384': 'sha384',
	sha512: 'sha512',
	'sha-512': 'sha512',
};

interface IntegrityItem {
	algorithm: Algorithm;
	/** base64, padded */
	digest: string;
}

/** a base64 or base64url value as base64, padded */
export function base64Standard(value: string): string {
	const plain = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	return plain + '='.repeat((4 - (plain.length % 4)) % 4);
}

/**
 * The metadata's valid items (the SRI spec's "parse metadata"): a token
 * that names no known algorithm or has no digest is ignored, and so are
 * its options (`?...`)
 */
function parseIntegrity(metadata: string): IntegrityItem[] {
	const items: IntegrityItem[] = [];
	for (const token of metadata.split(/[\t\n\f\r ]+/)) {
		const match =
			/^(sha-?(?:256|384|512))-([A-Za-z0-9+/_-]+={0,2})(?:\?.*)?$/.exec(token);
		if (!match) continue;
		items.push({
			algorithm: ALGORITHMS[match[1]],
			digest: base64Standard(match[2]),
		});
	}
	return items;
}

/**
 * The mark a route carries for `metadata` (a kind then this, before the
 * route's `/`): '' when there is nothing to check. The same metadata always
 * makes the same mark, so a preload and the load that uses it share a URL.
 */
export function integrityMark(metadata: string | null | undefined): string {
	if (metadata === null || metadata === undefined) return '';
	const items = parseIntegrity(metadata);
	if (!items.length) return INTEGRITY_MARK + NO_INTEGRITY;
	return (
		INTEGRITY_MARK +
		items
			.map(
				({ algorithm, digest }) =>
					`${algorithm.slice(3)}-${digest
						.replace(/\+/g, '-')
						.replace(/\//g, '_')
						.replace(/=+$/, '')}`,
			)
			.join('.')
	);
}

/**
 * `routed` with the mark of `metadata` after its kind (`directory` is the
 * route's path prefix, ending in `/`); as it is when there is nothing to
 * check or it is no route (a data: URL)
 */
export function markIntegrity(
	routed: string,
	metadata: string | null | undefined,
	directory: string,
): string {
	return withIntegrityMark(routed, integrityMark(metadata), directory);
}

/** `routed` with `mark` (an integrityMark, or '' for none) after its kind */
export function withIntegrityMark(
	routed: string,
	mark: string,
	directory: string,
): string {
	if (!mark) return routed;
	let start: number;
	try {
		start = new URL(routed).origin.length;
	} catch (error) {
		return routed;
	}
	if (!routed.startsWith(directory, start)) return routed;
	const end = routed.indexOf('/', start + directory.length);
	if (end === -1) return routed;
	const kind = routed.slice(start + directory.length, end);
	if (kind.includes(INTEGRITY_MARK)) return routed;
	return routed.slice(0, end) + mark + routed.slice(end);
}

/** a route kind without its integrity mark, and the mark's items ('' for none) */
export function splitIntegrityMark(kind: string): [string, string] {
	const at = kind.indexOf(INTEGRITY_MARK);
	return at === -1
		? [kind, '']
		: [kind.slice(0, at), kind.slice(at + INTEGRITY_MARK.length)];
}

/** the items of the strongest algorithm the metadata names (the only ones the SRI spec checks) */
export function strongestItems(metadata: string): IntegrityItem[] {
	const items = parseIntegrity(metadata);
	const rank = (algorithm: Algorithm) =>
		['sha256', 'sha384', 'sha512'].indexOf(algorithm);
	const best = Math.max(-1, ...items.map(({ algorithm }) => rank(algorithm)));
	return items.filter(({ algorithm }) => rank(algorithm) === best);
}

/**
 * The bytes of a data: URL, as the fetch spec's data: URL processor makes
 * them: the body percent-decoded, and base64-decoded where the type says
 * `;base64`; null for one the browser would not load
 */
export function dataURLBytes(url: string): Uint8Array | null {
	const comma = url.indexOf(',');
	if (!/^data:/i.test(url) || comma === -1) return null;
	const header = url.slice(5, comma);
	const body = url.slice(comma + 1).replace(/#.*$/s, '');
	const encoded = new TextEncoder().encode(body);
	const bytes: number[] = [];
	for (let i = 0; i < encoded.length; i++) {
		const hex = String.fromCharCode(encoded[i + 1] ?? 0, encoded[i + 2] ?? 0);
		if (encoded[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else bytes.push(encoded[i]);
	}
	if (!/;\s*base64\s*$/i.test(header)) return Uint8Array.from(bytes);
	// forgiving-base64: ASCII whitespace goes, and padding is optional
	let text = '';
	for (let at = 0; at < bytes.length; at += 8192)
		text += String.fromCharCode(...bytes.slice(at, at + 8192));
	text = text.replace(/[\t\n\f\r ]/g, '');
	try {
		const binary = atob(text);
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch (error) {
		return null;
	}
}
