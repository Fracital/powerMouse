// Whether bytes match a load's integrity metadata (./sri.ts), by the
// digests of ./sha.ts: the bytes the service worker serves for a load the
// browser must refuse (refusalBytes), and a data: script's or stylesheet's
// check in a document (src/inject/dom/modules/DOMAttributes.ts), where it is
// a deferred part of the document bundle (src/inject/dom/deferred.ts) with
// the page's policy checks, which share the digests.
import { digestBytes } from './sha';
import { strongestItems, type Algorithm } from './sri';

/** whether `bytes` match `metadata` as the browser checks them (metadata naming nothing valid matches anything) */
export function integrityHoldsSync(
	bytes: Uint8Array,
	metadata: string,
): boolean {
	const items = strongestItems(metadata);
	if (!items.length) return true;
	const digests = new Map<Algorithm, string>();
	return items.some(({ algorithm, digest }) => {
		if (!digests.has(algorithm))
			digests.set(algorithm, digestBytes(algorithm, bytes));
		return digests.get(algorithm) === digest;
	});
}

/**
 * Bytes that match none of `metadata`'s digests under the SRI rules
 * (integrityHoldsSync), for the browser to refuse; null when the metadata
 * names nothing valid, which anything matches
 */
export function refusalBytes(metadata: string): Uint8Array | null {
	if (!strongestItems(metadata).length) return null;
	const encoder = new TextEncoder();
	for (let n = 0; ; n++) {
		const bytes = encoder.encode(n ? `/*${n}*/` : '');
		if (!integrityHoldsSync(bytes, metadata)) return bytes;
	}
}
