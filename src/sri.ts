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
	if (!metadata) return '';
	const items = parseIntegrity(metadata);
	if (!items.length) return '';
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
